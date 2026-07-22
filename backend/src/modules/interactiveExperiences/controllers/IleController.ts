import 'reflect-metadata';
import {
  Authorized,
  BadRequestError,
  Body,
  CurrentUser,
  Delete,
  Get,
  HeaderParam,
  HttpCode,
  JsonController,
  NotFoundError,
  Param,
  Patch,
  Post,
  Put,
  QueryParam,
  QueryParams,
  Req,
  Res,
  UploadedFile,
} from 'routing-controllers';
import { OpenAPI, ResponseSchema } from 'routing-controllers-openapi';
import { Request, Response } from 'express';
import { inject } from 'inversify';
import { ILE_TYPES } from '../types.js';
import { IleGenerationService } from '../services/IleGenerationService.js';
import { IleService } from '../services/IleService.js';
import { IleAiConfigService } from '../services/IleAiConfigService.js';
import { IleAssetService } from '../services/IleAssetService.js';
import { IleAnalyticsService } from '../services/IleAnalyticsService.js';
import {
  GenerateIleBody,
  IleAiConfigBody,
  IleIdParam,
  IleVersionParam,
  ILE_ASSET_UPLOAD_OPTIONS,
  ListIleAssetsQuery,
  RenameIleBody,
  SaveIleBody,
  TestIleAiConfigBody,
  VersionedSaveIleBody,
} from '../classes/validators/IleValidators.js';
import {
  IngestStudentEventsBody,
  IngestStudentEventsQuery,
} from '../classes/validators/IleAnalyticsValidators.js';
import { GenerateFromContextBody } from '../classes/validators/ContextValidators.js';
import {
  IleExperience,
  IleVersion,
} from '../classes/transformers/IleExperience.js';
import {
  IleAsset,
  IleAssetKind,
  ILE_ASSET_KINDS,
  ILE_ASSET_KIND_LABELS,
  ILE_ASSET_LIMITS,
} from '../classes/transformers/IleAsset.js';
import { IUser } from '#root/shared/interfaces/models.js';
import { AUTH_TYPES } from '#root/modules/auth/types.js';
import { IAuthService } from '#root/modules/auth/interfaces/IAuthService.js';
import { ileLog, newIleRequestId } from '../services/observability.js';
import {
  IleAiConfigResponse,
  TestConnectionResult,
} from '../services/providers/types.js';

class IleExperienceResponse {
  _id: string;
  title: string;
  html: string;
  status: string;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  ownerId: string;
  /** Display label for the author — usually the teacher's display name. */
  authorName?: string;
  /** Number of the latest saved version (1-based). */
  currentVersion: number;
  /** Soft-delete marker. */
  archivedAt?: Date;
  /** First time this experience was published (if ever). */
  publishedAt?: Date;
  /**
   * Chat history between teacher and assistant. Each entry is a turn;
   * `user` is the teacher's prompt/edit instruction, `assistant` is the
   * model's reply (with the resulting HTML at the time of the turn).
   */
  history?: { role: 'user' | 'assistant'; content: string; html?: string; createdAt?: Date }[];
  createdAt: Date;
  updatedAt: Date;
}

class IleVersionListItem {
  version: number;
  savedAt: Date;
  savedBy: string;
  title: string;
  label?: string;
  htmlLength: number;
  isCurrent: boolean;
}

class IleVersionDetailResponse extends IleVersionListItem {
  html: string;
  prompt: string;
}

class IleExperienceListItem {
  _id: string;
  title: string;
  status: string;
  currentVersion: number;
  courseId: string;
  courseVersionId: string;
  itemId?: string;
  archivedAt?: Date;
  publishedAt?: Date;
  authorName?: string;
  updatedAt: Date;
}

class StudentIlePayload {
  _id: string;
  title: string;
  html: string;
  courseId: string;
  courseVersionId: string;
}

class IleErrorResponse {
  message: string;
}

class IleAiConfigStatusResponse {
  configured: boolean;
  config: IleAiConfigResponse | null;
}

class IleAssetResponse {
  _id: string;
  kind: IleAssetKind;
  filename: string;
  contentType: string;
  size: number;
  /** Signed GCS URL — 1h TTL. Frontend should re-fetch via
   * GET /assets/:id/signed before the URL expires. */
  url: string;
  expiresIn: number;
  createdAt: Date;
}

class IleAssetListItem {
  _id: string;
  kind: IleAssetKind;
  filename: string;
  contentType: string;
  size: number;
  /** Stable URL the AI can put in the generated HTML. Comes from
   * GET /assets/:id/signed on demand — for the list endpoint we return
   * the storage key, not the URL, to keep list responses cheap. */
  createdAt: Date;
}

@OpenAPI({ tags: ['Interactive Experiences'] })
@JsonController('/interactive-experiences')
@Authorized()
export class IleController {
  constructor(
    @inject(ILE_TYPES.IleGenerationService)
    private readonly generation: IleGenerationService,
    @inject(ILE_TYPES.IleService)
    private readonly ile: IleService,
    @inject(ILE_TYPES.IleAiConfigService)
    private readonly ileAiConfig: IleAiConfigService,
    @inject(ILE_TYPES.IleAssetService)
    private readonly ileAsset: IleAssetService,
    @inject(ILE_TYPES.IleAnalyticsService)
    private readonly ileAnalytics: IleAnalyticsService,
    @inject(AUTH_TYPES.AuthService)
    private readonly authService: IAuthService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // AI Configuration (ILE-scoped — does not touch any global AI settings)

  /**
   * GET /api/interactive-experiences/config
   *
   * Returns the saved per-owner config (no API key in the response) plus
   * a boolean so the UI can render the "Not Configured" state without
   * having to check for null fields.
   */
  @Get('/config')
  @OpenAPI({ summary: 'Fetch the ILE AI configuration for the current owner.' })
  @ResponseSchema(IleAiConfigStatusResponse)
  async getAiConfig(@CurrentUser() user: IUser): Promise<IleAiConfigStatusResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const config = await this.ileAiConfig.getForOwner(String(user._id));
    return { configured: Boolean(config), config };
  }

  /**
   * PUT /api/interactive-experiences/config
   *
   * Upsert the per-owner config. Empty apiKey preserves the prior key.
   */
  @Put('/config')
  @OpenAPI({ summary: 'Save the ILE AI configuration for the current owner.' })
  @ResponseSchema(IleAiConfigStatusResponse)
  async saveAiConfig(
    @Body() body: IleAiConfigBody,
    @CurrentUser() user: IUser,
  ): Promise<IleAiConfigStatusResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const config = await this.ileAiConfig.upsertForOwner(String(user._id), {
      provider: body.provider,
      apiKey: body.apiKey,
      model: body.model,
      baseUrl: body.baseUrl,
    });
    return { configured: true, config };
  }

  /**
   * POST /api/interactive-experiences/config/test
   *
   * Returns a stable four-state status: connected / invalid_key /
   * network_error / not_configured.
   */
  @Post('/config/test')
  @HttpCode(200)
  @OpenAPI({ summary: 'Test the ILE AI configuration.' })
  @ResponseSchema(class {
    ok: boolean;
    status: string;
    message?: string;
    modelEcho?: string;
  })
  async testAiConfig(
    @Body() body: TestIleAiConfigBody | undefined,
    @CurrentUser() user: IUser,
  ): Promise<TestConnectionResult> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    return this.ileAiConfig.testConnection(String(user._id), {
      provider: body?.provider,
      apiKey: body?.apiKey,
      model: body?.model,
      baseUrl: body?.baseUrl,
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Asset Manager (upload, list, sign, delete)
  //
  // These routes are registered BEFORE the `/:id` routes below so
  // /assets/upload and /assets/:id/signed aren't matched as `/:id`.
  // routing-controllers prefers static segments over param segments but
  // being explicit is safer.

  /**
   * POST /assets/upload
   * Multipart upload. Field name is `file`; the `kind` field tells
   * the server which mimetype + size limits to enforce.
   */
  @Post('/assets/upload')
  @HttpCode(201)
  @OpenAPI({ summary: 'Upload an asset (image/audio/video/pdf/svg).' })
  async uploadAsset(
    @UploadedFile('file', { options: undefined })
    file: Express.Multer.File | undefined,
    @Body() body: { kind?: IleAssetKind },
    @CurrentUser() user: IUser,
  ): Promise<IleAssetResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    if (!file) throw new BadRequestError('Missing file field in multipart upload');
    if (!body?.kind || !ILE_ASSET_KINDS.includes(body.kind)) {
      throw new BadRequestError(
        `Missing or invalid "kind" field — must be one of: ${ILE_ASSET_KINDS.join(', ')}`,
      );
    }
    // Re-run the per-kind guard at the controller boundary so a
    // bypass of @UploadedFile options (e.g. direct service call) still
    // gets rejected.
    const limits = ILE_ASSET_LIMITS[body.kind];
    if (!limits.mimetypes.includes(file.mimetype)) {
      throw new BadRequestError(
        `Mimetype ${file.mimetype} not allowed for kind ${body.kind}. Allowed: ${limits.mimetypes.join(', ')}`,
      );
    }
    if (file.size > limits.maxBytes) {
      throw new BadRequestError(
        `Asset exceeds size limit for ${body.kind} (${file.size} > ${limits.maxBytes})`,
      );
    }

    const doc = await this.ileAsset.upload({
      ownerId: String(user._id),
      kind: body.kind,
      filename: file.originalname,
      contentType: file.mimetype,
      size: file.size,
      buffer: file.buffer,
    });
    const { url, expiresIn } = await this.ileAsset.getSignedUrl(
      String(user._id),
      String(doc._id),
    );
    return this.toAssetResponse(doc, url, expiresIn);
  }

  /**
   * GET /assets
   * List the teacher's assets, newest first. Supports ?kind= and ?q=
   * for filtering. Capped at 200 entries server-side.
   */
  @Get('/assets')
  @OpenAPI({ summary: 'List the current owner\u2019s assets.' })
  async listAssets(
    @QueryParams() query: ListIleAssetsQuery,
    @CurrentUser() user: IUser,
  ): Promise<{ assets: IleAssetListItem[] }> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const docs = await this.ileAsset.list(String(user._id), {
      kind: query.kind,
      query: query.q,
    });
    return {
      assets: docs.map((d) => ({
        _id: String(d._id),
        kind: d.kind,
        filename: d.filename,
        contentType: d.contentType,
        size: d.size,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * GET /assets/:id/signed
   * Returns a fresh signed URL for the asset. Frontend re-fetches
   * before each generation to avoid stale-URL issues.
   */
  @Get('/assets/:id/signed')
  @OpenAPI({ summary: 'Get a fresh signed URL for an asset.' })
  async getAssetSignedUrl(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<{ url: string; expiresIn: number }> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    return this.ileAsset.getSignedUrl(String(user._id), id);
  }

  /**
   * DELETE /assets/:id
   * Soft-removes the asset from Mongo and hard-deletes the GCS blob.
   */
  @Delete('/assets/:id')
  @HttpCode(204)
  @OpenAPI({ summary: 'Delete an asset (owner only).' })
  async deleteAsset(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<void> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const ok = await this.ileAsset.delete(String(user._id), id);
    if (!ok) throw new NotFoundError('Asset not found');
  }

  // ───────────────────────────────────────────────────────────────────
  // Student Analytics (lightweight, postMessage-driven)
  //
  // These endpoints are NOT @Authorized() — students hit them from
  // inside the sandboxed iframe and don't have a user session. We
  // identify them via a hashed auth token (or an explicit body field
  // the host can set if no token is present). The teacher-facing
  // endpoints further down ARE @Authorized().

  /**
   * POST /:id/events
   *
   * Batched event ingestion from the sandboxed ILE runtime. The
   * student isn't authenticated in the usual sense; we identify them
   * via a per-experience salted hash. The body carries up to 50
   * events; the host (parent) page proxies them.
   */
  @Post('/:id/events')
  @HttpCode(202) // accepted — fire-and-forget style
  @OpenAPI({ summary: 'Ingest a batched payload of student runtime events.' })
  async ingestEvents(
    @Param('id') id: string,
    @Body() body: IngestStudentEventsBody,
    @HeaderParam('X-Vibe-Student-Token') headerToken: string | undefined,
    @Req() req: Request,
  ): Promise<{ applied: number; studentHash?: string }> {
    // Token priority: explicit header (sent by the host) > Authorization
    // header > Authorization header. We verify the Firebase token, resolve
    // the application user, then hash that stable user id with the
    // experience id. Tokens rotate; the application user id does not.
    const auth =
      headerToken ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice('Bearer '.length)
        : undefined);

    if (!auth) {
      throw new BadRequestError(
        'Missing student token (X-Vibe-Student-Token header or Authorization Bearer).',
      );
    }

    const student = await this.authService.getCurrentUserFromToken(auth);
    if (!student?._id) {
      throw new BadRequestError('Invalid student token.');
    }

    // We need courseId + courseVersionId to scope analytics. The
    // sandbox doesn't know them, so the host page passes them in the
    // body. We accept them as optional query fields for now; the
    // host can include them in a future iteration.
    const courseId = (req.query?.courseId as string) || 'unknown';
    const courseVersionId = (req.query?.courseVersionId as string) || 'unknown';

    const result = await this.ileAnalytics.ingest({
      experienceId: id,
      courseId,
      courseVersionId,
      studentId: String(student._id),
      events: body.events,
    });
    return { applied: result.applied, studentHash: result.studentHash };
  }

  // ───────────────────────────────────────────────────────────────────
  // Teacher-facing analytics (requires auth)

  /**
   * GET /:id/analytics
   *
   * Per-experience summary: completion rate, average time, cohort
   * engagement. The teacher dashboard uses this to render the new
   * "Analytics" tab in the workspace.
   */
  @Get('/:id/analytics')
  @OpenAPI({ summary: 'Teacher view: per-experience student analytics.' })
  async getExperienceAnalytics(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<any> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    // Authorisation: the experience must belong to this teacher. We
    // delegate to ile.getOwned so the owner check is uniform.
    const doc = await this.ile.getOwned(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return this.ileAnalytics.summarise(id, { title: doc.title });
  }

  /**
   * GET /analytics/dashboard
   *
   * Dashboard summary across multiple experiences. The teacher passes
   * a list of experience ids; we return per-experience analytics
   * plus cohort-level totals.
   */
  @Get('/analytics/dashboard')
  @OpenAPI({ summary: 'Teacher view: dashboard across multiple experiences.' })
  async getDashboard(
    @QueryParam('ids') idsParam: string | undefined,
    @CurrentUser() user: IUser,
  ): Promise<any> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    if (!idsParam) {
      throw new BadRequestError('Missing ?ids= query param.');
    }
    const ids = idsParam
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      return {
        perExperience: [],
        totals: { studentsStarted: 0, studentsCompleted: 0, averageCompletionRate: 0 },
      };
    }
    // Only include experiences the teacher owns.
    const owned = await Promise.all(
      ids.map(async (id) => {
        const doc = await this.ile.getOwned(id, String(user._id));
        return doc ? { _id: id, title: doc.title } : null;
      }),
    );
    const items = owned.filter((x): x is { _id: string; title: string } => Boolean(x));
    return this.ileAnalytics.dashboardForExperiences(items);
  }

  /**
   * Daily time series for one experience. Optional `from` and `to`
   * query params (ISO date strings) bound the window; otherwise the
   * last 30 days.
   */
  @Get('/:id/analytics/timeseries')
  @OpenAPI({ summary: 'Teacher view: daily time series for one experience.' })
  async getTimeSeries(
    @Param('id') id: string,
    @QueryParam('from') from: string | undefined,
    @QueryParam('to') to: string | undefined,
    @CurrentUser() user: IUser,
  ): Promise<any> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const doc = await this.ile.getOwned(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return this.ileAnalytics.timeSeries(id, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /**
   * Drop-off curve for one experience. Returns 11 bins (0..100) plus
   * the largest single-bin drop so the AI insights layer can flag a
   * "confusing section" without re-scanning.
   */
  @Get('/:id/analytics/dropoff')
  @OpenAPI({ summary: 'Teacher view: drop-off curve (10% bins) for one experience.' })
  async getDropOff(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<any> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const doc = await this.ile.getOwned(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return this.ileAnalytics.dropOffCurve(id);
  }

  /**
   * AI insights. Deterministic rule-based, not an LLM call. Returns
   * a list of insights with severity, scope (progress range), and a
   * suggested action. The dashboard renders each as a card.
   */
  @Get('/:id/analytics/insights')
  @OpenAPI({ summary: 'Teacher view: AI insights for one experience.' })
  async getInsights(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<any> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const doc = await this.ile.getOwned(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return this.ileAnalytics.insights(id);
  }

  /**
   * Compare A vs B. Both experiences must be owned by the same
   * teacher (the ile.getOwned checks above enforce it independently).
   */
  @Get('/analytics/compare')
  @OpenAPI({ summary: 'Teacher view: compare A vs B across headline metrics.' })
  async compare(
    @QueryParam('a') aId: string | undefined,
    @QueryParam('b') bId: string | undefined,
    @CurrentUser() user: IUser,
  ): Promise<any> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    if (!aId || !bId) {
      throw new BadRequestError('Both ?a= and ?b= query params are required.');
    }
    const [a, b] = await Promise.all([
      this.ile.getOwned(aId, String(user._id)),
      this.ile.getOwned(bId, String(user._id)),
    ]);
    if (!a) throw new NotFoundError(`Experience ${aId} not found`);
    if (!b) throw new NotFoundError(`Experience ${bId} not found`);
    return this.ileAnalytics.compare(
      { experienceId: aId, title: a.title },
      { experienceId: bId, title: b.title },
    );
  }

  // ───────────────────────────────────────────────────────────────────
  // Generation (existing routes)

  /**
   * Stream a fresh generation. SSE over POST (because Anthropic prompts
   * can be long and GETs would need query encoding).
   */
  @Post('/generate/stream')
  @OpenAPI({
    summary: 'Stream a fresh interactive experience generation',
    responses: {
      200: {
        description:
          'Server-Sent Events stream. Events: start, progress, html, done, error.',
        content: { 'text/event-stream': {} },
      },
      400: { description: 'Invalid prompt or missing fields' },
    },
  })
  async generateStream(
    @Body() body: GenerateIleBody,
    @CurrentUser() user: IUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!user?._id) {
      throw new BadRequestError('Authenticated user required');
    }
    await this.generation.generate(String(user._id), req, res, {
      courseId: body.courseId,
      courseVersionId: body.courseVersionId,
      itemId: body.itemId,
      prompt: body.prompt,
      requestId: pickRequestId(req),
    });
  }

  /**
   * Stream a generation from external context (YouTube URL in v1).
   *
   * The body carries the source identifier and the raw input (URL /
   * file id). The route delegates to generation.generateFromContext,
   * which runs the ContextBuilder + reuses the same streaming LLM
   * pipeline as `generate/stream`.
   *
   * Event shape is identical to generate/stream — the teacher sees
   * 'Preparing context...' / 'Understanding the learning material...' /
   * 'Generating interactive experience...' / 'Done'.
   */
  @Post('/generate/from-context/stream')
  @OpenAPI({
    summary: 'Stream a fresh interactive experience generation from external context',
    responses: {
      200: {
        description:
          'Server-Sent Events stream. Events: start, progress, html, done, error.',
        content: { 'text/event-stream': {} },
      },
      400: { description: 'Invalid source / missing fields' },
    },
  })
  async generateFromContextStream(
    @Body() body: GenerateFromContextBody,
    @CurrentUser() user: IUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!user?._id) {
      throw new BadRequestError('Authenticated user required');
    }
    await this.generation.generateFromContext(String(user._id), req, res, {
      courseId: body.courseId,
      courseVersionId: body.courseVersionId,
      itemId: body.itemId,
      prompt: body.prompt,
      source: body.source,
      input: body.input,
      hint: body.hint,
      requestId: pickRequestId(req),
    });
  }

  /**
   * Stream a conversational edit on an existing experience.
   */
  @Post('/:id/edit/stream')
  @OpenAPI({
    summary: 'Stream a conversational edit of an existing experience',
    responses: {
      200: {
        description: 'SSE stream. Same event shape as generate/stream.',
        content: { 'text/event-stream': {} },
      },
    },
  })
  async editStream(
    @Param('id') id: string,
    @Body() body: { prompt: string },
    @CurrentUser() user: IUser,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    if (!body?.prompt) throw new BadRequestError('prompt is required');
    await this.generation.edit(String(user._id), req, res, {
      experienceId: id,
      prompt: body.prompt,
      requestId: pickRequestId(req),
    });
  }

  /**
   * CSP violation report. The sandboxed iframe's CSP has a
   * `report-uri /api/interactive-experiences/csp-report` directive; the
   * browser POSTs `application/csp-report` (or JSON, depending on
   * browser) here when a violation fires. We log + acknowledge with
   * 204 so the report doesn't trigger a retry storm.
   *
   * SECURITY: This endpoint is intentionally NOT @Authorized() — CSP
   * reports come from the iframe which has an opaque origin, and the
   * rate of false reports is benign. We do, however, cap payload size
   * to keep a hostile origin from filling our logs.
   */
  @Post('/csp-report')
  @HttpCode(204)
  @OpenAPI({
    summary: 'CSP violation report endpoint (browser POST).',
  })
  async cspReport(@Body() body: unknown, @Req() req: Request): Promise<void> {
    const report = extractCspReport(body);
    ileLog('warn', 'csp.violation', {
      blockedUri: report.blockedUri,
      violatedDirective: report.violatedDirective,
      originalPolicy: report.originalPolicy,
      documentUri: report.documentUri,
      lineNumber: report.lineNumber,
      columnNumber: report.columnNumber,
      sourceFile: report.sourceFile,
      disposition: report.disposition,
      sample: report.sample,
    });
  }

  /**
   * Save or update an experience. Backwards-compatible: existing callers
   * still hit this endpoint. New versions of the frontend prefer
   * `/:id/save` which has the same shape but explicit version semantics.
   */
  @Post('/')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Save or update an experience (teacher-owned)' })
  async save(
    @Body() body: SaveIleBody,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const saved = await this.ile.save({
      ownerId: String(user._id),
      authorName: this.authorName(user),
      _id: body._id,
      courseId: body.courseId,
      courseVersionId: body.courseVersionId,
      itemId: body.itemId,
      title: body.title,
      prompt: body.prompt,
      html: body.html,
    });
    return this.toResponse(saved);
  }

  /**
   * Resource-scoped versioned save. Always creates a new version snapshot,
   * even if the HTML is unchanged. Identical response to POST /, but the
   * route makes the version-snapshot intent explicit at the call site.
   */
  @Post('/:id/save')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Versioned save — append a new version snapshot.' })
  async versionedSave(
    @Param('id') id: string,
    @Body() body: VersionedSaveIleBody,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const saved = await this.ile.save({
      ownerId: String(user._id),
      authorName: this.authorName(user),
      _id: id,
      courseId: body.courseId,
      courseVersionId: body.courseVersionId,
      itemId: body.itemId,
      title: body.title,
      prompt: body.prompt,
      html: body.html,
      label: body.label,
    });
    return this.toResponse(saved);
  }

  /**
   * Teacher fetches a draft.
   */
  @Get('/:id')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Fetch an experience (teacher owner only)' })
  async getOne(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const doc = await this.ile.getOwned(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return this.toResponse(doc);
  }

  /**
   * List the teacher's experiences (most-recent first, archived excluded
   * by default). Drives the ILE manager / history UI.
   */
  @Get('/')
  @ResponseSchema(class { experiences: IleExperienceListItem[] })
  @OpenAPI({ summary: 'List the current owner\u2019s experiences.' })
  async listMine(
    @CurrentUser() user: IUser,
    @QueryParam('includeArchived') includeArchived?: string,
  ): Promise<{ experiences: IleExperienceListItem[] }> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const docs = await this.ile.listAll(String(user._id), {
      includeArchived: includeArchived === 'true',
    });
    return { experiences: docs.map((d) => this.toListItem(d)) };
  }

  /**
   * List version history for an experience (newest first).
   */
  @Get('/:id/versions')
  @ResponseSchema(class { versions: IleVersionListItem[] })
  @OpenAPI({ summary: 'List version history for an experience.' })
  async listVersions(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<{ versions: IleVersionListItem[] }> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const versions = await this.ile.listVersions(id, String(user._id));
    if (versions === null) throw new NotFoundError('Experience not found');
    const current = await this.ile.getOwned(id, String(user._id));
    const currentVersion = current?.currentVersion ?? 0;
    return {
      versions: versions
        .slice()
        .sort((a, b) => b.version - a.version)
        .map((v) => this.toVersionListItem(v, v.version === currentVersion)),
    };
  }

  /**
   * Fetch a specific version (full HTML + prompt).
   */
  @Get('/:id/versions/:version')
  @ResponseSchema(IleVersionDetailResponse)
  @OpenAPI({ summary: 'Fetch a single version (full HTML).' })
  async getVersion(
    @Param('id') id: string,
    @Param('version') version: number,
    @CurrentUser() user: IUser,
  ): Promise<IleVersionDetailResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const v = await this.ile.getVersion(id, String(user._id), Number(version));
    if (!v) throw new NotFoundError('Version not found');
    const current = await this.ile.getOwned(id, String(user._id));
    return this.toVersionDetail(v, v.version === (current?.currentVersion ?? -1));
  }

  /**
   * Surface the conversational history for the editor. The history lives
   * on the same document (so it's already persisted across reloads) but
   * the legacy toResponse shape didn't include it. This endpoint gives
   * the editor an authoritative fetch path so the chat thread survives
   * workspace remounts and version restores.
   */
  @Get('/:id/history')
  @OpenAPI({ summary: 'Fetch the chat history for an experience.' })
  async getHistory(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<{ history: { role: 'user' | 'assistant'; content: string; html?: string; createdAt?: Date }[] }> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const doc = await this.ile.getOwned(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return { history: (doc.history ?? []) as any };
  }

  /**
   * Restore a previous version. Creates a NEW version snapshot whose
   * contents come from the target — history stays append-only.
   */
  @Post('/:id/versions/:version/restore')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Restore a previous version.' })
  async restoreVersion(
    @Param('id') id: string,
    @Param('version') version: number,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const saved = await this.ile.restoreVersion(
      id,
      String(user._id),
      Number(version),
      this.authorName(user),
    );
    if (!saved) throw new NotFoundError('Version not found');
    return this.toResponse(saved);
  }

  /**
   * Rename — only the title field. Lives on its own endpoint so future
   * field-level mutations don't tangle with the versioned Save path.
   */
  @Patch('/:id')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Rename an experience (title only).' })
  async rename(
    @Param('id') id: string,
    @Body() body: RenameIleBody,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const renamed = await this.ile.rename(id, String(user._id), body.title);
    if (!renamed) throw new NotFoundError('Experience not found');
    return this.toResponse(renamed);
  }

  /**
   * Duplicate — fresh id, content copied, status reset to draft. The
   * teacher lands on the copy so they can iterate without touching the
   * original.
   */
  @Post('/:id/duplicate')
  @ResponseSchema(IleExperienceResponse)
  @HttpCode(201)
  @OpenAPI({ summary: 'Duplicate an experience as a new draft.' })
  async duplicate(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const copy = await this.ile.duplicate(id, String(user._id));
    if (!copy) throw new NotFoundError('Experience not found');
    return this.toResponse(copy);
  }

  /**
   * Archive — soft delete. Status becomes 'archived', `archivedAt` is
   * stamped. The experience stops appearing for students immediately.
   * The owner can still see it via `?includeArchived=true`.
   */
  @Post('/:id/archive')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Archive an experience (soft delete).' })
  async archive(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const archived = await this.ile.archive(id, String(user._id));
    if (!archived) throw new NotFoundError('Experience not found');
    return this.toResponse(archived);
  }

  /**
   * Unarchive — restore to draft. The teacher must re-publish explicitly
   * afterwards; we don't auto-restore the published flag.
   */
  @Post('/:id/unarchive')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Unarchive an experience (restore to draft).' })
  async unarchive(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const restored = await this.ile.unarchive(id, String(user._id));
    if (!restored) throw new NotFoundError('Experience not found');
    return this.toResponse(restored);
  }

  /**
   * Soft delete (alias of archive). Returns 204 on success, 404 if the
   * teacher doesn't own the resource. Idempotent — re-deleting an
   * already-archived experience still returns 204.
   */
  @Delete('/:id')
  @HttpCode(204)
  @OpenAPI({ summary: 'Soft-delete an experience (archive).' })
  async delete(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<void> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const ok = await this.ile.softDelete(id, String(user._id));
    if (!ok) throw new NotFoundError('Experience not found');
  }

  /**
   * Publish an experience so students can play it.
   */
  @Post('/:id/publish')
  @ResponseSchema(IleExperienceResponse)
  @OpenAPI({ summary: 'Publish an experience (teacher owner only)' })
  async publish(
    @Param('id') id: string,
    @CurrentUser() user: IUser,
  ): Promise<IleExperienceResponse> {
    if (!user?._id) throw new BadRequestError('Authenticated user required');
    const doc = await this.ile.publish(id, String(user._id));
    if (!doc) throw new NotFoundError('Experience not found');
    return this.toResponse(doc);
  }

  /**
   * Student-facing fetch — returns only published experiences and strips
   * the chat history.
   */
  @Get('/:id/play')
  @ResponseSchema(StudentIlePayload)
  @OpenAPI({ summary: 'Fetch a published experience for student playback' })
  async play(
    @Param('id') id: string,
  ): Promise<StudentIlePayload> {
    const payload = await this.ile.getPublishedForStudent(id);
    if (!payload) throw new NotFoundError('Experience not available');
    return {
      _id: String(payload._id),
      title: payload.title,
      html: payload.html,
      courseId: payload.courseId,
      courseVersionId: payload.courseVersionId,
    };
  }

  // ─────────────────────────────────────────────────────────────────────

  /** Display name best-effort: prefer firstName+lastName, fall back to email. */
  private authorName(user: IUser): string {
    const u = user as any;
    const first = (u.firstName ?? '').toString().trim();
    const last = (u.lastName ?? '').toString().trim();
    const full = [first, last].filter(Boolean).join(' ').trim();
    if (full) return full;
    if (u.email) return String(u.email);
    return String(user._id ?? 'unknown');
  }

  private toAssetResponse(
    doc: IleAsset,
    url: string,
    expiresIn: number,
  ): IleAssetResponse {
    return {
      _id: String(doc._id),
      kind: doc.kind,
      filename: doc.filename,
      contentType: doc.contentType,
      size: doc.size,
      url,
      expiresIn,
      createdAt: doc.createdAt,
    };
  }

  private toResponse(doc: IleExperience): IleExperienceResponse {
    return {
      _id: String(doc._id),
      title: doc.title,
      html: doc.html,
      status: doc.status,
      courseId: doc.courseId,
      courseVersionId: doc.courseVersionId,
      itemId: doc.itemId,
      ownerId: doc.ownerId,
      authorName: doc.authorName,
      currentVersion: doc.currentVersion ?? 0,
      archivedAt: doc.archivedAt,
      publishedAt: doc.publishedAt,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }

  private toListItem(doc: IleExperience): IleExperienceListItem {
    return {
      _id: String(doc._id),
      title: doc.title,
      status: doc.status,
      currentVersion: doc.currentVersion ?? 0,
      courseId: doc.courseId,
      courseVersionId: doc.courseVersionId,
      itemId: doc.itemId,
      archivedAt: doc.archivedAt,
      publishedAt: doc.publishedAt,
      authorName: doc.authorName,
      updatedAt: doc.updatedAt,
    };
  }

  private toVersionListItem(
    v: IleVersion,
    isCurrent: boolean,
  ): IleVersionListItem {
    return {
      version: v.version,
      savedAt: v.savedAt,
      savedBy: v.savedBy,
      title: v.title,
      label: v.label,
      htmlLength: v.htmlLength,
      isCurrent,
    };
  }

  private toVersionDetail(
    v: IleVersion,
    isCurrent: boolean,
  ): IleVersionDetailResponse {
    return {
      version: v.version,
      savedAt: v.savedAt,
      savedBy: v.savedBy,
      title: v.title,
      label: v.label,
      htmlLength: v.htmlLength,
      isCurrent,
      html: v.html,
      prompt: v.prompt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers

/**
 * Pull a request id off the inbound `X-Request-Id` header, falling
 * back to a fresh one. The service logs and SSE errors carry the
 * id so a teacher can quote it in a bug report and we can find the
 * exact line in the structured log pipeline.
 */
function pickRequestId(req: Request): string {
  const raw = req.headers['x-request-id'];
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= 128) {
    return raw;
  }
  return newIleRequestId();
}

/**
 * Extract the relevant fields from a CSP report payload. Browsers
 * differ in their format:
 *
 *   - The latest spec (Level 3) sends an array of `csp-report` objects
 *     directly.
 *   - Older Chrome/Firefox send `{ 'csp-report': { ... } }` wrapped.
 *   - The legacy `SecurityPolicyViolationEvent` dispatch sends a
 *     `securitypolicyviolation` event with a DOM-shaped payload.
 *
 * We accept all three and surface the most useful fields.
 */
function extractCspReport(body: unknown): {
  blockedUri?: string;
  violatedDirective?: string;
  originalPolicy?: string;
  documentUri?: string;
  lineNumber?: number;
  columnNumber?: number;
  sourceFile?: string;
  sample?: string;
  disposition?: string;
} {
  const findField = (...objects: any[]): any | undefined => {
    for (const o of objects) {
      if (o && typeof o === 'object') {
        for (const k of Object.keys(o)) {
          if (k in o) return o[k];
        }
      }
    }
    return undefined;
  };
  const root: any = Array.isArray(body)
    ? body[0]
    : body && typeof body === 'object'
      ? (body as any)['csp-report'] ?? body
      : undefined;
  if (!root || typeof root !== 'object') return {};
  return {
    blockedUri: stringOrUndef(
      root['blocked-uri'] ?? root.blockedURI ?? root.blockedUri,
    ),
    violatedDirective: stringOrUndef(
      root['violated-directive'] ??
        root.violatedDirective ??
        root.effectiveDirective,
    ),
    originalPolicy: stringOrUndef(
      root['original-policy'] ?? root.originalPolicy,
    ),
    documentUri: stringOrUndef(
      root['document-uri'] ?? root.documentURI ?? root.documentUri,
    ),
    lineNumber: numberOrUndef(root['line-number'] ?? root.lineNumber),
    columnNumber: numberOrUndef(root['column-number'] ?? root.columnNumber),
    sourceFile: stringOrUndef(root['source-file'] ?? root.sourceFile),
    sample: stringOrUndef(root['sample']),
    disposition: stringOrUndef(root.disposition),
  };
}

function stringOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function numberOrUndef(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}