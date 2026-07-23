import { Injectable } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import { PrismaService } from '../db/prisma.service';
import { toPreferences, toUser } from './user.mapper';
import type { UpdatePreferencesDto, UpdateProfileDto } from './users.dto';
import type { User, UserPreferences } from '@shared';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<User> {
    const row = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!row) throw AppException.notFound('user_not_found', 'User no longer exists');
    return toUser(row);
  }

  async preferences(userId: string): Promise<UserPreferences> {
    return (await this.get(userId)).preferences;
  }

  async updateProfile(userId: string, patch: UpdateProfileDto): Promise<User> {
    const row = await this.prisma.user.update({
      where: { id: userId },
      data: { displayName: patch.displayName?.trim() || null },
    });
    return toUser(row);
  }

  /** Partial update: only the keys present in the patch change. */
  async updatePreferences(
    userId: string,
    patch: UpdatePreferencesDto,
  ): Promise<UserPreferences> {
    const current = await this.preferences(userId);
    const merged = toPreferences({ ...current, ...patch });

    await this.prisma.user.update({
      where: { id: userId },
      data: { preferences: merged as unknown as object },
    });
    return merged;
  }
}
