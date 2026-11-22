import { DurableObject } from 'cloudflare:workers';
import { FalcoBudget } from './operations.mjs';

export class FalcoBudgetObject extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.budget = new FalcoBudget(state);
  }
  reserve(config) { return this.budget.reserve(config); }
  record(observation) { return this.budget.record(observation); }
  summary() { return this.budget.summary(); }
}
