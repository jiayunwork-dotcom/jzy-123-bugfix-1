import {
  AggregateAlreadyExistsError,
  AggregateNotFoundError,
  DomainError,
  ValidationError,
} from '../errors.js';

/**
 * 账户聚合 —— 本框架目前唯一的聚合类型。
 *
 * 事件溯源的两个纯函数核心：
 * - evolveAccount：状态迁移。给定当前状态与一条已发生的事件，返回新状态。
 *   它不做任何校验（事件既然已落库就是事实），只负责"应用"。
 * - decideAccount：决策。给定当前状态与一条命令，先做业务校验，
 *   合法才返回待追加的事件；不合法直接抛错 —— 不产生任何事件。
 */
export const ACCOUNT_AGGREGATE_TYPE = 'account';

export interface AccountState {
  exists: boolean;
  owner: string | null;
  /** 余额，单位：分（整数，避免浮点误差） */
  balanceCents: number;
}

export const initialAccountState: AccountState = {
  exists: false,
  owner: null,
  balanceCents: 0,
};

export interface AccountEventPayloads {
  AccountCreated: { owner: string; initialBalanceCents: number };
  MoneyDeposited: { amountCents: number };
  MoneyWithdrawn: { amountCents: number };
}

export type AccountEventType = keyof AccountEventPayloads;

export interface AccountEvent {
  eventType: AccountEventType;
  payload: AccountEventPayloads[AccountEventType];
}

export type AccountCommand =
  | { type: 'CreateAccount'; owner: string; initialBalanceCents?: number }
  | { type: 'DepositMoney'; amountCents: number }
  | { type: 'WithdrawMoney'; amountCents: number };

/** 状态迁移：把一条事件应用到状态上（纯函数，无副作用） */
export function evolveAccount(state: AccountState, event: AccountEvent): AccountState {
  switch (event.eventType) {
    case 'AccountCreated': {
      const payload = event.payload as AccountEventPayloads['AccountCreated'];
      return { exists: true, owner: payload.owner, balanceCents: payload.initialBalanceCents };
    }
    case 'MoneyDeposited': {
      const payload = event.payload as AccountEventPayloads['MoneyDeposited'];
      return { ...state, balanceCents: state.balanceCents + payload.amountCents };
    }
    case 'MoneyWithdrawn': {
      const payload = event.payload as AccountEventPayloads['MoneyWithdrawn'];
      return { ...state, balanceCents: state.balanceCents - payload.amountCents };
    }
    default:
      // 历史里出现不认识的事件类型时必须显式失败，而不是静默跳过
      throw new Error(`unknown account event type: ${String((event as { eventType?: unknown }).eventType)}`);
  }
}

function assertAmount(amountCents: unknown, field: string, allowZero = false): asserts amountCents is number {
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents)) {
    throw new ValidationError(`'${field}' must be an integer number of cents`, { [field]: amountCents });
  }
  if (allowZero ? amountCents < 0 : amountCents <= 0) {
    throw new ValidationError(`'${field}' must be ${allowZero ? '>= 0' : '> 0'}`, { [field]: amountCents });
  }
}

/**
 * 决策：校验命令并生成事件。
 * 所有业务约束（账户必须存在、金额必须为正、余额不得为负……）都在这里、
 * 在事件产生之前校验；校验失败抛错，调用方因此不会追加任何事件。
 */
export function decideAccount(
  aggregateId: string,
  command: AccountCommand,
  state: AccountState,
): AccountEvent[] {
  switch (command.type) {
    case 'CreateAccount': {
      if (state.exists) throw new AggregateAlreadyExistsError(aggregateId);
      const owner = typeof command.owner === 'string' ? command.owner.trim() : '';
      if (owner.length === 0) throw new ValidationError('account owner must be a non-empty string');
      const initialBalanceCents = command.initialBalanceCents ?? 0;
      assertAmount(initialBalanceCents, 'initialBalanceCents', true);
      return [{ eventType: 'AccountCreated', payload: { owner, initialBalanceCents } }];
    }
    case 'DepositMoney': {
      if (!state.exists) throw new AggregateNotFoundError(aggregateId);
      assertAmount(command.amountCents, 'amountCents');
      return [{ eventType: 'MoneyDeposited', payload: { amountCents: command.amountCents } }];
    }
    case 'WithdrawMoney': {
      if (!state.exists) throw new AggregateNotFoundError(aggregateId);
      assertAmount(command.amountCents, 'amountCents');
      if (command.amountCents > state.balanceCents) {
        throw new DomainError(
          'INSUFFICIENT_FUNDS',
          `cannot withdraw ${command.amountCents} cents from account '${aggregateId}': balance is ${state.balanceCents} cents`,
          { aggregateId, balanceCents: state.balanceCents, amountCents: command.amountCents },
        );
      }
      return [{ eventType: 'MoneyWithdrawn', payload: { amountCents: command.amountCents } }];
    }
    default:
      throw new ValidationError(`unknown command type: ${JSON.stringify(command)}`);
  }
}
