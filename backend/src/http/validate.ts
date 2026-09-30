import type { AccountCommand } from '../domain/account.js';
import { ValidationError } from '../errors.js';

/** HTTP 入参的形状校验（领域层仍会独立做业务校验，两层职责不同） */

export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValidationError(`'${field}' must be a non-empty string`);
  }
  return value.trim();
}

export function requireInt(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`'${field}' must be an integer`, { got: value });
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ValidationError(`'${field}' must be >= ${opts.min}`, { got: value });
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ValidationError(`'${field}' must be <= ${opts.max}`, { got: value });
  }
  return value;
}

export function optionalInt(
  value: unknown,
  field: string,
  opts: { min?: number; max?: number } = {},
): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireInt(value, field, opts);
}

/** query string 里的整数参数（原始值是字符串） */
export function parseQueryInt(
  raw: string | undefined,
  field: string,
  opts: { min?: number } = {},
): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new ValidationError(`query parameter '${field}' must be an integer`, { got: raw });
  }
  if (opts.min !== undefined && n < opts.min) {
    throw new ValidationError(`query parameter '${field}' must be >= ${opts.min}`, { got: raw });
  }
  return n;
}

export function parseAccountCommand(raw: unknown): AccountCommand {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError(`'command' must be an object with a 'type' field`);
  }
  const c = raw as Record<string, unknown>;
  switch (c.type) {
    case 'CreateAccount':
      return {
        type: 'CreateAccount',
        owner: requireString(c.owner, 'command.owner'),
        initialBalanceCents: optionalInt(c.initialBalanceCents, 'command.initialBalanceCents', { min: 0 }),
      };
    case 'DepositMoney':
      return { type: 'DepositMoney', amountCents: requireInt(c.amountCents, 'command.amountCents', { min: 1 }) };
    case 'WithdrawMoney':
      return { type: 'WithdrawMoney', amountCents: requireInt(c.amountCents, 'command.amountCents', { min: 1 }) };
    default:
      throw new ValidationError(`unknown command type: ${String(c.type)}`, {
        allowed: ['CreateAccount', 'DepositMoney', 'WithdrawMoney'],
      });
  }
}
