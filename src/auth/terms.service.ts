import { Injectable } from '@nestjs/common';

import { AppException } from '../common/app-exception';
import { PrismaService } from '../db/prisma.service';
import type { Language, TermsDocument } from '@shared';

@Injectable()
export class TermsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The version a new registration must accept. */
  async currentVersion(): Promise<string> {
    const row = await this.prisma.termsDocument.findFirst({
      where: { isCurrent: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (!row) {
      throw AppException.badGateway(
        'terms_missing',
        'No current terms document is loaded. Run npm run seed.',
      );
    }
    return row.version;
  }

  async get(language: Language): Promise<TermsDocument> {
    const row =
      (await this.prisma.termsDocument.findFirst({ where: { isCurrent: true, language } })) ??
      (await this.prisma.termsDocument.findFirst({ where: { isCurrent: true } }));

    if (!row) {
      throw AppException.notFound('terms_missing', 'No terms document is loaded');
    }

    return {
      version: row.version,
      language: row.language as Language,
      title: row.title,
      body: row.body,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
