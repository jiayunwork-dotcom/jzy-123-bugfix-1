/**
 * 统一错误类型。
 *
 * 每个错误都带有稳定的机器可读 code 与 HTTP 状态码，
 * HTTP 层据此把错误映射成一致的错误响应：
 *   { "error": { "code", "message", "details" } }
 */
export class AppError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(code: string, httpStatus: number, message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** 请求参数 / 输入格式不合法（400） */
export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', 400, message, details);
  }
}

/** 聚合不存在（404） */
export class AggregateNotFoundError extends AppError {
  constructor(aggregateId: string, details?: unknown) {
    super('AGGREGATE_NOT_FOUND', 404, `aggregate '${aggregateId}' does not exist`, {
      aggregateId,
      ...(details as object | undefined),
    });
  }
}

/** 乐观并发冲突：客户端持有的版本与服务端最新版本不一致（409） */
export class VersionConflictError extends AppError {
  constructor(aggregateId: string, expectedVersion: number, actualVersion: number | null) {
    super(
      'VERSION_CONFLICT',
      409,
      `version conflict on aggregate '${aggregateId}': client expected version ${expectedVersion}, ` +
        `but the current version is ${actualVersion === null ? 'unknown' : actualVersion}. ` +
        `Reload the latest state and retry.`,
      { aggregateId, expectedVersion, actualVersion },
    );
  }
}

/** 重放目标版本超出已有事件范围（400） */
export class VersionOutOfRangeError extends AppError {
  constructor(aggregateId: string, requestedVersion: number, currentVersion: number) {
    super(
      'VERSION_OUT_OF_RANGE',
      400,
      `cannot rebuild aggregate '${aggregateId}' at version ${requestedVersion}: ` +
        `current version is ${currentVersion}`,
      { aggregateId, requestedVersion, currentVersion },
    );
  }
}

/** 快照版本超出已有事件范围（400） */
export class SnapshotVersionOutOfRangeError extends AppError {
  constructor(aggregateId: string, requestedVersion: number, currentVersion: number) {
    super(
      'SNAPSHOT_VERSION_OUT_OF_RANGE',
      400,
      `cannot snapshot aggregate '${aggregateId}' at version ${requestedVersion}: ` +
        `version must be within 1..${currentVersion}`,
      { aggregateId, requestedVersion, currentVersion },
    );
  }
}

/** 业务规则违反（422），如余额不足。校验发生在生成事件之前，因此不会产生任何事件。 */
export class DomainError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, 422, message, details);
  }
}

/** 重复创建同一聚合（409） */
export class AggregateAlreadyExistsError extends AppError {
  constructor(aggregateId: string) {
    super('AGGREGATE_ALREADY_EXISTS', 409, `aggregate '${aggregateId}' already exists`, { aggregateId });
  }
}
