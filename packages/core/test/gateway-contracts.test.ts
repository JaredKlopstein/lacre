import { describe, it, expect } from 'vitest';
import { evaluateContracts, type Contract, type ContractSet } from '../src/gateway/contracts.js';

/**
 * The contract evaluator: the decision Lacre makes *before* a call is
 * forwarded. Phase 2 of #274.
 *
 * Three properties here are load-bearing rather than cosmetic, and each has a
 * test that fails if it is lost:
 *
 *  - **The most restrictive matching contract wins.** First-match-wins would
 *    mean an `allow` written above a `deny` silently disables it, which is the
 *    classic firewall footgun. Order must not be able to weaken a deny.
 *  - **The evaluator is total.** It is on the path of production traffic. A
 *    malformed predicate, a bad regex or a hostile argument shape must produce
 *    a verdict, never an exception.
 *  - **An unevaluable predicate is not an allow.** The default is fail-closed:
 *    if the gate cannot tell, it refuses. A gate that fails open is not a gate.
 */

const call = (over: Partial<Parameters<typeof evaluateContracts>[1]> = {}) => ({
  tool: 'write_file',
  sideEffectClass: 'write' as const,
  args: { path: '/tmp/x', mode: 'overwrite' } as Record<string, unknown>,
  ...over,
});

const set = (contracts: Contract[], over: Partial<ContractSet> = {}): ContractSet => ({
  contracts,
  ...over,
});

describe('contract matching', () => {
  it('reports not_applicable when no contract matches', () => {
    const v = evaluateContracts(set([{ id: 'c1', effect: 'deny', tools: ['delete_everything'] }]), call());
    expect(v.effect).toBe('allow');
    expect(v.contractId).toBeNull();
    expect(v.result).toBe('not_applicable');
  });

  it('reports not_applicable for an empty contract set', () => {
    const v = evaluateContracts(set([]), call());
    expect(v.result).toBe('not_applicable');
    expect(v.effect).toBe('allow');
  });

  it('matches on tool name', () => {
    const v = evaluateContracts(set([{ id: 'c1', effect: 'deny', tools: ['write_file'] }]), call());
    expect(v.effect).toBe('deny');
    expect(v.contractId).toBe('c1');
    expect(v.result).toBe('rejected');
  });

  it('matches on side-effect class', () => {
    const v = evaluateContracts(
      set([{ id: 'irreversible-only', effect: 'require_approval', sideEffectClasses: ['irreversible'] }]),
      call({ sideEffectClass: 'irreversible' }),
    );
    expect(v.effect).toBe('require_approval');
    expect(v.contractId).toBe('irreversible-only');
  });

  it('does not match a different side-effect class', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', sideEffectClasses: ['irreversible'] }]),
      call({ sideEffectClass: 'read' }),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('a contract with no selectors matches every call', () => {
    const v = evaluateContracts(set([{ id: 'catch-all', effect: 'deny' }]), call());
    expect(v.contractId).toBe('catch-all');
    expect(v.effect).toBe('deny');
  });

  it('requires every selector to hold, not any', () => {
    // Right tool, wrong class: a contract is an AND of its selectors.
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', tools: ['write_file'], sideEffectClasses: ['irreversible'] }]),
      call({ sideEffectClass: 'write' }),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('carries the contract reason into the verdict', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', tools: ['write_file'], reason: 'no writes during the freeze' }]),
      call(),
    );
    expect(v.reason).toBe('no writes during the freeze');
  });
});

describe('argument predicates', () => {
  it('exists matches a present argument', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'path', op: 'exists' }] }]),
      call(),
    );
    expect(v.effect).toBe('deny');
  });

  it('exists does not match an absent argument', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'nope', op: 'exists' }] }]),
      call(),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('absent matches a missing argument', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'nope', op: 'absent' }] }]),
      call(),
    );
    expect(v.effect).toBe('deny');
  });

  it('equals compares by value and type', () => {
    const yes = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'mode', op: 'equals', value: 'overwrite' }] }]),
      call(),
    );
    expect(yes.effect).toBe('deny');
    const no = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'mode', op: 'equals', value: 'append' }] }]),
      call(),
    );
    expect(no.result).toBe('not_applicable');
  });

  it('equals does not coerce 1 to "1"', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'n', op: 'equals', value: 1 }] }]),
      call({ args: { n: '1' } }),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('matches applies a regex to a string argument', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'path', op: 'matches', pattern: '^/etc/' }] }]),
      call({ args: { path: '/etc/passwd' } }),
    );
    expect(v.effect).toBe('deny');
  });

  it('matches does not match a non-string argument, and does not error', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'path', op: 'matches', pattern: '^/etc/' }] }]),
      call({ args: { path: 42 } }),
    );
    expect(v.result).toBe('not_applicable');
    expect(v.errored).toBe(false);
  });

  it('reads a nested path', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'target.host', op: 'equals', value: 'prod' }] }]),
      call({ args: { target: { host: 'prod' } } }),
    );
    expect(v.effect).toBe('deny');
  });

  it('indexes into an array', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'hosts.1', op: 'equals', value: 'b' }] }]),
      call({ args: { hosts: ['a', 'b'] } }),
    );
    expect(v.effect).toBe('deny');
  });

  it('does not read inherited properties', () => {
    // A tool argument named "constructor" or "__proto__" must not resolve to a
    // prototype member and quietly satisfy a predicate.
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'constructor', op: 'exists' }] }]),
      call({ args: { path: '/tmp/x' } }),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('treats a call with no arguments as having none present', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'path', op: 'exists' }] }]),
      call({ args: undefined }),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('requires every predicate to hold', () => {
    const v = evaluateContracts(
      set([
        {
          id: 'c1',
          effect: 'deny',
          where: [
            { path: 'path', op: 'exists' },
            { path: 'nope', op: 'exists' },
          ],
        },
      ]),
      call(),
    );
    expect(v.result).toBe('not_applicable');
  });
});

describe('the most restrictive contract wins', () => {
  const allow: Contract = { id: 'allow-writes', effect: 'allow', tools: ['write_file'] };
  const approve: Contract = { id: 'approve-writes', effect: 'require_approval', tools: ['write_file'] };
  const deny: Contract = { id: 'deny-writes', effect: 'deny', tools: ['write_file'] };

  it('deny beats allow regardless of order', () => {
    expect(evaluateContracts(set([allow, deny]), call()).effect).toBe('deny');
    expect(evaluateContracts(set([deny, allow]), call()).effect).toBe('deny');
  });

  it('deny beats require_approval regardless of order', () => {
    expect(evaluateContracts(set([approve, deny]), call()).effect).toBe('deny');
    expect(evaluateContracts(set([deny, approve]), call()).effect).toBe('deny');
  });

  it('require_approval beats allow regardless of order', () => {
    expect(evaluateContracts(set([allow, approve]), call()).effect).toBe('require_approval');
    expect(evaluateContracts(set([approve, allow]), call()).effect).toBe('require_approval');
  });

  it('names the winning contract, not the first that matched', () => {
    const v = evaluateContracts(set([allow, deny]), call());
    expect(v.contractId).toBe('deny-writes');
  });

  it('breaks a tie between equal effects by declaration order', () => {
    const v = evaluateContracts(
      set([
        { id: 'first', effect: 'deny', tools: ['write_file'] },
        { id: 'second', effect: 'deny', tools: ['write_file'] },
      ]),
      call(),
    );
    expect(v.contractId).toBe('first');
  });

  it('an explicit allow records passed, not not_applicable', () => {
    const v = evaluateContracts(set([allow]), call());
    expect(v.effect).toBe('allow');
    expect(v.contractId).toBe('allow-writes');
    expect(v.result).toBe('passed');
  });
});

describe('the evaluator is total and fails closed', () => {
  const badRegex: Contract = {
    id: 'bad-regex',
    effect: 'allow',
    tools: ['write_file'],
    where: [{ path: 'path', op: 'matches', pattern: '([' }],
  };

  it('does not throw on an invalid regex', () => {
    expect(() => evaluateContracts(set([badRegex]), call())).not.toThrow();
  });

  it('denies on an unevaluable predicate by default', () => {
    const v = evaluateContracts(set([badRegex]), call());
    expect(v.effect).toBe('deny');
    expect(v.errored).toBe(true);
    expect(v.contractId).toBe('bad-regex');
  });

  it('names the contract and the reason when it fails closed', () => {
    const v = evaluateContracts(set([badRegex]), call());
    expect(v.reason).toMatch(/bad-regex/);
    expect(v.reason).toMatch(/could not be evaluated/i);
  });

  it('fail_open skips the contract it could not evaluate', () => {
    const v = evaluateContracts(set([badRegex], { onError: 'fail_open' }), call());
    expect(v.effect).toBe('allow');
    expect(v.result).toBe('not_applicable');
    expect(v.errored).toBe(true);
  });

  it('fail_open does not suppress a different contract that does match', () => {
    const v = evaluateContracts(
      set([badRegex, { id: 'real-deny', effect: 'deny', tools: ['write_file'] }], { onError: 'fail_open' }),
      call(),
    );
    expect(v.effect).toBe('deny');
    expect(v.contractId).toBe('real-deny');
  });

  it('an error outranks a matching allow even when fail-closed', () => {
    const v = evaluateContracts(set([{ id: 'ok', effect: 'allow', tools: ['write_file'] }, badRegex]), call());
    expect(v.effect).toBe('deny');
    expect(v.contractId).toBe('bad-regex');
  });

  it('rejects an absurdly long regex rather than running it', () => {
    const v = evaluateContracts(
      set([
        {
          id: 'huge',
          effect: 'allow',
          tools: ['write_file'],
          where: [{ path: 'path', op: 'matches', pattern: 'a'.repeat(5000) }],
        },
      ]),
      call(),
    );
    expect(v.errored).toBe(true);
    expect(v.effect).toBe('deny');
  });

  it('survives a hostile argument object', () => {
    const hostile = JSON.parse('{"__proto__": {"path": "/etc/passwd"}}') as Record<string, unknown>;
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', where: [{ path: 'path', op: 'exists' }] }]),
      call({ args: hostile }),
    );
    expect(v.result).toBe('not_applicable');
  });

  it('treats an unknown operator as unevaluable rather than as a match', () => {
    const v = evaluateContracts(
      set([
        {
          id: 'c1',
          effect: 'allow',
          tools: ['write_file'],
          // A contract set may come from configuration written by an older or
          // newer build; an operator this build does not know is not an allow.
          where: [{ path: 'path', op: 'startsWith' } as never],
        },
      ]),
      call(),
    );
    expect(v.errored).toBe(true);
    expect(v.effect).toBe('deny');
  });
});

describe('dry run', () => {
  it('reports the verdict it would have reached', () => {
    const v = evaluateContracts(
      set([{ id: 'c1', effect: 'deny', tools: ['write_file'] }], { dryRun: true }),
      call(),
    );
    expect(v.effect).toBe('deny');
    expect(v.result).toBe('rejected');
  });
});
