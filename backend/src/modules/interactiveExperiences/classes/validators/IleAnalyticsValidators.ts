import { JSONSchema } from 'class-validator-jsonschema';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

// Canonical event-kind enumeration. The runtime, the transformer
// type, the analytics service's allowed-set, and this validator's
// `as const` array all derive from this single source of truth —
// see also IleStudentEventKind in classes/transformers/IleStudentProgress.ts.
export const ILE_EVENT_KINDS = [
  'started',
  'progress',
  'interaction',
  'complete',
  'error',
  'resume',
  'retry',
] as const;

const EVENT_KINDS = ILE_EVENT_KINDS;
export type IleEventKindDto = (typeof EVENT_KINDS)[number];

/**
 * Batched-event payload from the sandboxed ILE runtime.
 *
 * The runtime collects events in memory and flushes them on a 2s
 * interval (or on visibilitychange / pagehide). One POST carries up
 * to 50 events.
 */
export class IleStudentEventDto {
  @JSONSchema({ enum: EVENT_KINDS as unknown as string[] })
  @IsIn(EVENT_KINDS as unknown as string[])
  kind: IleEventKindDto;

  /**
   * Client-reported epoch ms. Best-effort; the server stamps its own.
   *
   * Note: upper bound is intentionally NOT @Max()-decorated. The previous
   * `@Max(Date.now() + 24h)` was evaluated at module-load time and
   * stayed frozen at process boot — a long-running process would silently
   * reject valid client timestamps as "too far in the future". The
   * service-side `sanitiseEvent` clamps the upper bound per-request.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  clientTs?: number;

  /** Free-form payload. For 'progress' this is `{ percent: number }`. */
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;
}

export class IngestStudentEventsBody {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => IleStudentEventDto)
  events: IleStudentEventDto[];
}