import { ApiError } from './api';

/** 分 → 元的展示格式化（仅展示层换算，业务计算都在后端） */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}¥${(abs / 100).toFixed(2)}`;
}

/** 元 → 分的输入解析（仅输入换算；合法性仍由后端最终裁决） */
export function parseYuanToCents(input: string): number {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('请输入金额');
  const n = Number(trimmed);
  if (!Number.isFinite(n)) throw new Error('金额必须是数字');
  const cents = Math.round(n * 100);
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('金额必须是不为负的数');
  return cents;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 把后端错误翻译成给人看的提示 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.code) {
      case 'VERSION_CONFLICT':
        return `版本冲突：${err.message}`;
      case 'AGGREGATE_NOT_FOUND':
        return `聚合不存在：${err.message}`;
      case 'AGGREGATE_ALREADY_EXISTS':
        return `聚合已存在：${err.message}`;
      case 'INSUFFICIENT_FUNDS':
        return `余额不足：${err.message}`;
      case 'SNAPSHOT_VERSION_OUT_OF_RANGE':
      case 'VERSION_OUT_OF_RANGE':
        return `版本超出范围：${err.message}`;
      case 'VALIDATION_FAILED':
        return `参数不合法：${err.message}`;
      default:
        return `${err.code}: ${err.message}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
