import { JSONSchema } from 'class-validator-jsonschema';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const EVENT_KINDS = ['started', 'progress', 'interaction', 'complete', 'error', 'resume', 'retry'] as const;
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

  /** Client-reported epoch ms. Best-effort; the server stamps its own. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Date.now() + 24 * 60 * 60 * 1000) // 24h into the future max
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

/**
 * The student's auth token is read from the Authorization header by
 * the host (parent) page and sent as part of the body OR as a header
 * field. We accept it as a body field so the host can post it as
 * `Authorization: Bearer <token>` and the controller can extract it
 * from there — OR so the IFRAME can be told to include it via a
 * host-set window global.
 *
 * For MVP we accept it as a header field. The frontend's event
 * reporter reads `localStorage.firebase-auth-token` and sets the header.
 */
export class IngestStudentEventsQuery {
  @JSONSchema({
    description: 'Optional explicit student token. If absent, server falls back to Authorization header.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  token?: string;
}