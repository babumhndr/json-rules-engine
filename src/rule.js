'use strict';

import Condition from './condition';
import RuleResult from './rule-result';
import debug from './debug';
import deepClone from 'clone';
import EventEmitter from 'eventemitter2';

class Rule extends EventEmitter {
  /**
   * Returns a new Rule instance
   * @param {object|string} options - Options object or JSON string that can be parsed into options
   * @param {number} options.priority - Priority (>1), higher runs sooner.
   * @param {Object} options.event - Event to fire when rule evaluates as successful
   * @param {string} options.event.type - Name of event to emit
   * @param {Object} [options.event.params] - Parameters to pass to the event listener
   * @param {Object} options.conditions - Conditions to evaluate when processing this rule
   * @param {any} options.name - Identifier for a particular rule, particularly valuable in RuleResult output
   * @return {Rule} instance
   */
  constructor(options) {
    super();
    if (typeof options === 'string') {
      options = JSON.parse(options);
    }
    if (options && options.conditions) {
      this.setConditions(options.conditions);
    }
    if (options && options.onSuccess) {
      this.on('success', options.onSuccess);
    }
    if (options && options.onFailure) {
      this.on('failure', options.onFailure);
    }
    if (options && (options.name || options.name === 0)) {
      this.setName(options.name);
    }

    const priority = (options && options.priority) || 1;
    this.setPriority(priority);

    const event = (options && options.event) || { type: 'unknown' };
    this.setEvent(event);
  }

  /**
   * Sets the priority of the rule
   * @param {number} priority - Increasing the priority causes the rule to be run prior to other rules
   */
  setPriority(priority) {
    priority = parseInt(priority, 10);
    if (priority <= 0) throw new Error('Priority must be greater than zero');
    this.priority = priority;
    return this;
  }

  /**
   * Sets the name of the rule
   * @param {any} name - Any truthy input and zero is allowed
   */
  setName(name) {
    if (!name && name !== 0) {
      throw new Error('Rule "name" must be defined');
    }
    this.name = name;
    return this;
  }

  /**
   * Sets the conditions to run when evaluating the rule.
   * @param {object} conditions - Conditions, root element must be a boolean operator
   */
  setConditions(conditions) {
    if (
      !Object.prototype.hasOwnProperty.call(conditions, 'all') &&
      !Object.prototype.hasOwnProperty.call(conditions, 'any') &&
      !Object.prototype.hasOwnProperty.call(conditions, 'not')
    ) {
      throw new Error(
        '"conditions" root must contain a single instance of "all", "any", or "not"'
      );
    }
    this.conditions = new Condition(conditions);
    return this;
  }

  /**
   * Sets the event to emit when the conditions evaluate truthy
   * @param {object} event - Event to emit
   * @param {string} event.type - Event name to emit on
   * @param {Object} [event.params] - Parameters to emit as the argument of the event emission
   */
  setEvent(event) {
    if (!event) throw new Error('Rule: setEvent() requires event object');
    if (!Object.prototype.hasOwnProperty.call(event, 'type')) {
      throw new Error(
        'Rule: setEvent() requires event object with "type" property'
      );
    }
    this.ruleEvent = {
      type: event.type
    };
    if (event.params) this.ruleEvent.params = event.params;
    return this;
  }

  /**
   * Returns the event object
   * @returns {Object} event
   */
  getEvent() {
    return this.ruleEvent;
  }

  /**
   * Returns the priority
   * @returns {Number} priority
   */
  getPriority() {
    return this.priority;
  }

  /**
   * Returns the conditions object
   * @returns {Object} conditions
   */
  getConditions() {
    return this.conditions;
  }

  /**
   * Returns the engine object
   * @returns {Object} engine
   */
  getEngine() {
    return this.engine;
  }

  /**
   * Sets the engine to run the rules under
   * @param {object} engine
   * @returns {Rule}
   */
  setEngine(engine) {
    this.engine = engine;
    return this;
  }

  toJSON(stringify = true) {
    const props = {
      conditions: this.conditions.toJSON(false),
      priority: this.priority,
      event: this.ruleEvent,
      name: this.name
    };
    if (stringify) {
      return JSON.stringify(props);
    }
    return props;
  }

  /**
   * Prioritizes an array of conditions based on "priority"
   * @param  {Condition[]} conditions
   * @return {Condition[][]} prioritized two-dimensional array of conditions
   * Each outer array element represents a single priority(integer).  Inner array is
   * all conditions with that priority.
   */
  prioritizeConditions(conditions) {
    const factSets = conditions.reduce((sets, condition) => {
      // if a priority has been set on this specific condition, honor that first
      // otherwise, use the fact's priority
      let priority = condition.priority;
      if (!priority) {
        const fact = this.engine.getFact(condition.fact);
        priority = (fact && fact.priority) || 1;
      }
      if (!sets[priority]) sets[priority] = [];
      sets[priority].push(condition);
      return sets;
    }, {});
    return Object.keys(factSets)
      .sort((a, b) => Number(b) - Number(a)) // order highest priority -> lowest
      .map((priority) => factSets[priority]);
  }

  /**
   * Evaluates the rule, starting with the root boolean operator and recursing down
   * All evaluation is done within the context of an almanac
   * @return {Promise<RuleResult>} rule evaluation result
   */
  evaluate(almanac) {
    const ruleResult = new RuleResult(
      this.conditions,
      this.ruleEvent,
      this.priority,
      this.name
    );

    /**
     * Evaluates the rule conditions
     * @param  {Condition} condition - Condition to evaluate
     * @return {Promise<boolean>} - Resolves with the result of the condition evaluation
     */
    const evaluateCondition = (condition) => {
      if (condition.isConditionReference()) {
        return realize(condition);
      } else if (condition.isBooleanOperator()) {
        const subConditions = condition[condition.operator];
        let comparisonPromise;
        if (condition.operator === 'all') {
          comparisonPromise = all(subConditions);
        } else if (condition.operator === 'any') {
          comparisonPromise = any(subConditions);
        } else {
          comparisonPromise = not(subConditions);
        }
        // for booleans, rule passing is determined by the all/any/not result
        return comparisonPromise.then((comparisonValue) => {
          const passes = comparisonValue === true;
          condition.result = passes;
          return passes;
        });
      } else {
        return condition
          .evaluate(almanac, this.engine.operators)
          .then((evaluationResult) => {
            const passes = evaluationResult.result;
            condition.factResult = evaluationResult.leftHandSideValue;
            condition.result = passes;
            return passes;
          });
      }
    };

    /**
     * Evaluates an array of conditions, using an 'every' or 'some' array operation
     * @param  {Condition[]} conditions
     * @param  {Function} method - Array method to call for determining result
     * @return {Promise<boolean>} whether conditions evaluated truthy or falsey based on condition evaluation + method
     */
    const evaluateConditions = (conditions, method) => {
      if (!Array.isArray(conditions)) conditions = [conditions];

      return Promise.all(
        conditions.map((condition) => evaluateCondition(condition))
      ).then((conditionResults) => {
        debug('rule::evaluateConditions results', conditionResults);
        return method.call(conditionResults, (result) => result === true);
      });
    };

    /**
     * Evaluates a set of conditions based on an 'all', 'any', or 'not' operator.
     * First, orders the top level conditions based on priority
     * Iterates over each priority set, evaluating each condition
     * If any condition results in the rule to be guaranteed truthy or falsey,
     * it will short-circuit and not bother evaluating any additional rules
     * @param  {Condition[]} conditions - Conditions to be evaluated
     * @param  {string} operator - 'all'|'any'|'not'
     * @return {Promise<boolean>} rule evaluation result
     */
    const prioritizeAndRun = (conditions, operator) => {
      if (conditions.length === 0) {
        return Promise.resolve(true);
      }
      if (conditions.length === 1) {
        // no prioritizing is necessary, just evaluate the single condition
        // 'all' and 'any' will give the same results with a single condition so no method is necessary
        // this also covers the 'not' case which should only ever have a single condition
        return evaluateCondition(conditions[0]);
      }
      let method = Array.prototype.some;
      if (operator === 'all') {
        method = Array.prototype.every;
      }
      const orderedSets = this.prioritizeConditions(conditions);
      let cursor = Promise.resolve();
      // use for() loop over Array.forEach to support IE8 without polyfill
      for (let i = 0; i < orderedSets.length; i++) {
        const set = orderedSets[i];
        let stop = false;
        cursor = cursor.then((setResult) => {
          // after the first set succeeds, don't fire off the remaining promises
          if ((operator === 'any' && setResult === true) || stop) {
            debug(
              'prioritizeAndRun::detected truthy result; skipping remaining conditions'
            );
            stop = true;
            return true;
          }

          // after the first set fails, don't fire off the remaining promises
          if ((operator === 'all' && setResult === false) || stop) {
            debug(
              'prioritizeAndRun::detected falsey result; skipping remaining conditions'
            );
            stop = true;
            return false;
          }
          // all conditions passed; proceed with running next set in parallel
          return evaluateConditions(set, method);
        });
      }
      return cursor;
    };

    /**
     * Runs an 'any' boolean operator on an array of conditions
     * @param  {Condition[]} conditions to be evaluated
     * @return {Promise<boolean>} condition evaluation result
     */
    const any = (conditions) => {
      return prioritizeAndRun(conditions, 'any');
    };

    /**
     * Runs an 'all' boolean operator on an array of conditions
     * @param  {Condition[]} conditions to be evaluated
     * @return {Promise<boolean>} condition evaluation result
     */
    const all = (conditions) => {
      return prioritizeAndRun(conditions, 'all');
    };

    /**
     * Runs a 'not' boolean operator on a single condition
     * @param  {Condition} condition to be evaluated
     * @return {Promise<boolean>} condition evaluation result
     */
    const not = (condition) => {
      return prioritizeAndRun([condition], 'not').then((result) => !result);
    };

    /**
     * Dereferences the condition reference and then evaluates it.
     * @param {Condition} conditionReference
     * @returns {Promise<boolean>} condition evaluation result
     */
    const realize = (conditionReference) => {
      const condition = this.engine.conditions.get(conditionReference.condition);
      if (!condition) {
        if (this.engine.allowUndefinedConditions) {
          // undefined conditions always fail
          conditionReference.result = false;
          return Promise.resolve(false);
        } else {
          throw new Error(
            `No condition ${conditionReference.condition} exists`
          );
        }
      } else {
        // project the referenced condition onto reference object and evaluate it.
        delete conditionReference.condition;
        Object.assign(conditionReference, deepClone(condition));
        return evaluateCondition(conditionReference);
      }
    };

    /**
     * Emits based on rule evaluation result, and decorates ruleResult with 'result' property
     * @param {RuleResult} ruleResult
     * @param {boolean} result
     */
    const processResult = (result) => {
      ruleResult.setResult(result);
      let processEvent = Promise.resolve();
      if (this.engine.replaceFactsInEventParams) {
        processEvent = ruleResult.resolveEventParams(almanac);
      }
      const event = result ? 'success' : 'failure';
      return processEvent.then(() =>
        this.emitAsync(event, ruleResult.event, almanac, ruleResult).then(
          () => ruleResult
        )
      );
    };

    if (ruleResult.conditions.any) {
      return any(ruleResult.conditions.any).then((result) =>
        processResult(result)
      );
    } else if (ruleResult.conditions.all) {
      return all(ruleResult.conditions.all).then((result) =>
        processResult(result)
      );
    } else if (ruleResult.conditions.not) {
      return not(ruleResult.conditions.not).then((result) =>
        processResult(result)
      );
    } else {
      return realize(ruleResult.conditions).then((result) =>
        processResult(result)
      );
    }
  }
}

export default Rule;
