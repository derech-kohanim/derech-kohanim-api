import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { AppException } from '../common/app-exception';
import { config } from '../config';
import { PrismaService } from '../db/prisma.service';
import { toPreferences } from '../users/user.mapper';
import { AdminNavService } from './admin-nav.service';
import type { UpdateUserDto } from './admin.dto';
import type { AdminUser, AdminUserDetail, AdminUserList } from './admin.types';

/** Row shape shared by the list and the detail query. */
type UserRow = Prisma.UserGetPayload<{
  include: {
    _count: {
      select: {
        navSessions: true;
        routes: true;
        navFeedback: true;
        savedPlaces: true;
        recentPlaces: true;
      };
    };
  };
}>;

const COUNTS = {
  _count: {
    select: {
      navSessions: true,
      routes: true,
      navFeedback: true,
      savedPlaces: true,
      recentPlaces: true,
    },
  },
} as const;

@Injectable()
export class AdminUsersService {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly nav: AdminNavService,
  ) {}

  /**
   * Accounts, newest first, with the activity counts that make a row worth clicking. `search`
   * matches the email or display name, case-insensitively.
   */
  async list(search: string | undefined, limit: number, offset: number): Promise<AdminUserList> {
    const term = search?.trim();
    const where: Prisma.UserWhereInput = term
      ? {
          OR: [
            { email: { contains: term, mode: 'insensitive' } },
            { displayName: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {};

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: COUNTS,
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      this.prisma.user.count({ where }),
    ]);

    const lastSessions = await this.lastSessionByUser(rows.map((row) => row.id));
    return {
      users: rows.map((row) => toUser(row, lastSessions.get(row.id) ?? null)),
      total,
    };
  }

  async get(id: string): Promise<AdminUserDetail> {
    const row = await this.prisma.user.findUnique({ where: { id }, include: COUNTS });
    if (!row) throw AppException.notFound('user_not_found', 'No such user');

    const lastSessions = await this.lastSessionByUser([row.id]);
    const recentSessions = await this.nav.listSessions('all', 10, 0, row.id);

    return {
      ...toUser(row, lastSessions.get(row.id) ?? null),
      savedPlaceCount: row._count.savedPlaces,
      recentPlaceCount: row._count.recentPlaces,
      recentSessions,
    };
  }

  /** Only the fields an operator may legitimately change: the display name and the tier. */
  async update(id: string, patch: UpdateUserDto): Promise<AdminUserDetail> {
    await this.get(id);
    await this.prisma.user.update({
      where: { id },
      data: {
        ...(patch.tier === undefined ? {} : { tier: patch.tier }),
        ...(patch.displayName === undefined
          ? {}
          : { displayName: patch.displayName.trim() || null }),
      },
    });
    return this.get(id);
  }

  /**
   * Deletes the account and everything personal to it (refresh tokens, saved and recent places)
   * by cascade. Routes, sessions and feedback are kept but disowned (user_id set to null), so
   * the routing data an operator is debugging does not vanish with the account.
   */
  async remove(id: string, actingAdminEmail: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw AppException.notFound('user_not_found', 'No such user');

    const email = user.email?.trim().toLowerCase();
    if (email && config.adminEmails.includes(email)) {
      // Removing an admin account through the console it is signed into is never the intent.
      throw AppException.badRequest(
        'admin_user_protected',
        'Administrator accounts cannot be deleted from the console',
      );
    }

    await this.prisma.user.delete({ where: { id } });
    this.logger.warn(`Admin ${actingAdminEmail} deleted user ${id}`);
  }

  /** Newest session start per user, in one grouped query rather than one per row. */
  private async lastSessionByUser(userIds: string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    const grouped = await this.prisma.navSession.groupBy({
      by: ['userId'],
      where: { userId: { in: userIds } },
      _max: { startedAt: true },
    });
    return new Map(
      grouped
        .filter((entry): entry is typeof entry & { userId: string } => entry.userId !== null)
        .map((entry) => [entry.userId, (entry._max.startedAt ?? new Date(0)).toISOString()]),
    );
  }
}

function toUser(row: UserRow, lastSessionAt: string | null): AdminUser {
  const preferences = toPreferences(row.preferences);
  const email = row.email?.trim().toLowerCase();

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    tier: row.tier,
    providers: row.providers,
    isAdmin: Boolean(email && config.adminEmails.includes(email)),
    stringency: preferences.stringency,
    language: preferences.language,
    acceptedTermsVersion: row.acceptedTermsVersion,
    acceptedTermsAt: row.acceptedTermsAt ? row.acceptedTermsAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    sessionCount: row._count.navSessions,
    routeCount: row._count.routes,
    feedbackCount: row._count.navFeedback,
    lastSessionAt,
  };
}
