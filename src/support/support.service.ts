import { Injectable, Logger } from "@nestjs/common";

import { AppException } from "../common/app-exception";
import { config } from "../config";
import { PrismaService } from "../db/prisma.service";
import type {
  SupportKind,
  SupportReportRequest,
  SupportReportResponse,
} from "@shared";

const KIND_LABEL_HE: Record<SupportKind, string> = {
  bug: "בעיה באפליקציה",
  route: "בעיה במסלול",
  data: "תיקון נתוני האזורים",
  suggestion: "הצעה או משוב",
};

/** Reports per user per rolling hour. */
const HOURLY_LIMIT = 5;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Files user reports as issues in the private support repository. The GitHub token lives only
 * on the server: a token inside the app could be lifted by anyone holding the APK or the site's
 * bundle. Reports go to a private repository because they carry routes and locations.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);
  private readonly recent = new Map<string, number[]>();

  constructor(private readonly prisma: PrismaService) {}

  async report(
    userId: string,
    input: SupportReportRequest,
  ): Promise<SupportReportResponse> {
    if (!config.supportGithubToken) {
      throw AppException.serviceUnavailable(
        "support_not_configured",
        "Reports are not configured on this server",
      );
    }
    this.throttle(userId);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const zone =
      input.zoneId != null ? await this.zoneSummary(input.zoneId) : null;
    const route = input.routeId ? await this.routeSummary(input.routeId) : null;

    const labels = [input.kind, input.platform];
    const body = this.body(input, {
      zone,
      route,
      email: input.replyByEmail ? (user?.email ?? null) : null,
      name: user?.displayName ?? null,
    });

    // A second report about the same zone joins the open issue instead of opening another.
    const zoneTag = input.zoneId != null ? `[אזור ${input.zoneId}]` : null;
    if (zoneTag) {
      const open = await this.findOpenIssue(zoneTag);
      if (open) {
        await this.github(`/issues/${open}/comments`, { body });
        return { reference: open, merged: true };
      }
    }

    const summary = clean(input.message).replace(/\s+/g, " ").slice(0, 60);
    const title = [zoneTag, `${KIND_LABEL_HE[input.kind]}: ${summary}`]
      .filter(Boolean)
      .join(" ");
    const issue = (await this.github("/issues", { title, body, labels })) as {
      number: number;
    };
    return { reference: issue.number, merged: false };
  }

  private throttle(userId: string): void {
    const now = Date.now();
    const times = (this.recent.get(userId) ?? []).filter(
      (t) => now - t < HOUR_MS,
    );
    if (times.length >= HOURLY_LIMIT) {
      throw AppException.tooManyRequests(
        "support_rate_limited",
        "Too many reports in the last hour, please try again later",
      );
    }
    times.push(now);
    this.recent.set(userId, times);
  }

  private body(
    input: SupportReportRequest,
    ctx: {
      zone: string | null;
      route: string | null;
      email: string | null;
      name: string | null;
    },
  ): string {
    const lines = [
      clean(input.message),
      "",
      "---",
      `**סוג:** ${KIND_LABEL_HE[input.kind]}`,
      `**פלטפורמה:** ${input.platform}, גרסה ${clean(input.appVersion).slice(0, 40)}`,
    ];
    if (input.device)
      lines.push(`**מכשיר:** ${clean(input.device).slice(0, 200)}`);
    if (ctx.zone) lines.push(`**אזור:** ${ctx.zone}`);
    if (ctx.route) lines.push(`**מסלול:** ${ctx.route}`);
    if (input.location) {
      const { lat, lng } = input.location;
      lines.push(
        `**מיקום:** [${lat.toFixed(5)}, ${lng.toFixed(5)}](https://www.google.com/maps?q=${lat},${lng})`,
      );
    }
    if (ctx.email) {
      lines.push(
        `**לחזור אל:** ${clean(ctx.name ?? "")} ${clean(ctx.email)}`.replace(
          /\s+/g,
          " ",
        ),
      );
    } else {
      lines.push("**לחזור אל:** המשתמש לא ביקש תשובה");
    }
    return lines.join("\n");
  }

  private async zoneSummary(id: number): Promise<string | null> {
    const rows = await this.prisma.$queryRawUnsafe<
      {
        name_he: string | null;
        name: string;
        city: string | null;
        stringency: string;
      }[]
    >(
      `SELECT z.name_he, z.name, z.city, l.stringency
         FROM zones z JOIN zone_layers l ON l.id = z.layer_id
        WHERE z.id = $1`,
      id,
    );
    const row = rows[0];
    if (!row) return `#${id} (לא נמצא במסד)`;
    return clean(
      `#${id} ${row.name_he ?? row.name}${row.city ? `, ${row.city}` : ""} (${row.stringency})`,
    );
  }

  private async routeSummary(id: string): Promise<string | null> {
    const row = await this.prisma.route.findUnique({ where: { id } });
    if (!row) return `${id} (פג תוקף או לא נמצא)`;
    const request = row.request as {
      origin?: { lat: number; lng: number };
      destination?: { lat: number; lng: number };
      stringency?: string;
      avoidTolls?: boolean;
    };
    const point = (p?: { lat: number; lng: number }) =>
      p ? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}` : "?";
    return (
      `\`${id}\`, מ-${point(request.origin)} אל ${point(request.destination)}, ` +
      `רמה ${request.stringency ?? "?"}${request.avoidTolls ? ", בלי אגרה" : ""}`
    );
  }

  private async findOpenIssue(tag: string): Promise<number | null> {
    const issues = (await this.github(
      `/issues?state=open&labels=data&per_page=100`,
      null,
      "GET",
    )) as {
      number: number;
      title: string;
      pull_request?: unknown;
    }[];
    return (
      issues.find((i) => !i.pull_request && i.title.startsWith(tag))?.number ??
      null
    );
  }

  private async github(
    path: string,
    payload: unknown,
    method = "POST",
  ): Promise<unknown> {
    const response = await fetch(
      `https://api.github.com/repos/${config.supportGithubRepo}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${config.supportGithubToken}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "derech-kohanim-api",
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      this.logger.warn(
        `GitHub ${method} ${path} failed (${response.status}): ${detail.slice(0, 300)}`,
      );
      throw AppException.serviceUnavailable(
        "support_failed",
        "The report could not be sent",
      );
    }
    return response.json();
  }
}

/** No @-mentions (nobody on GitHub gets pinged by a user's text) and no control characters. */
function clean(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/@/g, "@​")
    .trim();
}
