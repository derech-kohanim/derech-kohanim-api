import { Injectable, Logger } from '@nestjs/common';
import type { DeletionRequest as DeletionRequestRow, Prisma } from '@prisma/client';

import { AppException } from '../common/app-exception';
import { PrismaService } from '../db/prisma.service';
import type { CreateDeletionRequestDto } from './account.dto';
import type {
  DeletionRequest,
  DeletionRequestReceipt,
  DeletionRequestSource,
  DeletionRequestStatus,
} from '@shared';

const RESOLVED: DeletionRequestStatus[] = ['completed', 'rejected'];

/**
 * Account and data deletion requests. Creating one never deletes anything: the row is the
 * request, and an operator resolves it from the console once the requester is verified. That
 * split is deliberate, because the public form has no way to prove who is typing into it.
 */
@Injectable()
export class DeletionRequestsService {
  private readonly logger = new Logger(DeletionRequestsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a request. A signed-in caller's own address is used and marked verified, so the
   * form cannot be pointed at somebody else's account. An anonymous request is still linked to
   * a matching account when one exists - useful to the operator, invisible to the caller.
   *
   * An open request for the same address is returned as-is rather than duplicated, so a
   * repeated submit is idempotent and the queue cannot be flooded from one address.
   */
  async create(
    userId: string | null,
    body: CreateDeletionRequestDto,
  ): Promise<DeletionRequestReceipt> {
    const signedInUser = userId
      ? await this.prisma.user.findUnique({ where: { id: userId } })
      : null;

    // Being signed in only proves an address when the account actually carries one. Without it
    // the caller is treated as anonymous rather than having a typed-in address inherit their
    // session's trust - that would let them aim the form at somebody else's account.
    const ownEmail = signedInUser?.email?.trim().toLowerCase() || null;
    const email = ownEmail ?? body.email.trim().toLowerCase();
    const verified = ownEmail !== null;
    // Addresses are stored lower-cased at registration, so the normalised form is the key.
    const matched = verified
      ? signedInUser
      : await this.prisma.user.findUnique({ where: { email } });

    const open = await this.prisma.deletionRequest.findFirst({
      where: { email, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });

    if (open) {
      // A pending request already covers this address. Promote it if this submission proves the
      // address, and record a reason the first one did not carry.
      const row =
        verified && !open.verified
          ? await this.prisma.deletionRequest.update({
              where: { id: open.id },
              data: {
                verified: true,
                userId: matched?.id ?? open.userId,
                reason: open.reason ?? body.reason?.trim() ?? null,
              },
            })
          : open;
      return receipt(row);
    }

    const row = await this.prisma.deletionRequest.create({
      data: {
        userId: matched?.id ?? null,
        email,
        verified,
        reason: body.reason?.trim() || null,
        source: body.source ?? 'web',
      },
    });

    this.logger.warn(
      `Deletion request ${row.id} raised for ${email} (verified: ${verified}, ` +
        `account: ${row.userId ?? 'none'})`,
    );
    return receipt(row);
  }

  /** Console listing, newest first. `status` of undefined means every status. */
  async list(
    status: DeletionRequestStatus | undefined,
    limit: number,
    offset: number,
  ): Promise<DeletionRequest[]> {
    const where: Prisma.DeletionRequestWhereInput = status ? { status } : {};
    const rows = await this.prisma.deletionRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      take: limit,
      skip: offset,
    });
    return rows.map(toRequest);
  }

  async get(id: string): Promise<DeletionRequest> {
    const row = await this.prisma.deletionRequest.findUnique({ where: { id } });
    if (!row) throw AppException.notFound('deletion_request_not_found', 'No such request');
    return toRequest(row);
  }

  /**
   * Resolves a request. Only the status and the operator note are writable: the request itself
   * (who asked, when, for which address) is an audit record and stays as it was submitted.
   */
  async resolve(
    id: string,
    status: DeletionRequestStatus,
    note: string | undefined,
    adminEmail: string,
  ): Promise<DeletionRequest> {
    await this.get(id);
    const resolved = RESOLVED.includes(status);

    const row = await this.prisma.deletionRequest.update({
      where: { id },
      data: {
        status,
        ...(note === undefined ? {} : { note: note.trim() || null }),
        // Reopening clears the handling trail, so a stale operator name never sits on a
        // request that is pending again.
        handledBy: resolved ? adminEmail : null,
        handledAt: resolved ? new Date() : null,
      },
    });

    this.logger.warn(`Admin ${adminEmail} set deletion request ${id} to ${status}`);
    return toRequest(row);
  }

  /**
   * Marks every pending request for an address as completed, once the account behind it is
   * gone. Keyed on the email rather than the user id because deleting the account nulls
   * `user_id` on the very rows this needs to find.
   */
  async completeForEmail(email: string, adminEmail: string): Promise<void> {
    await this.prisma.deletionRequest.updateMany({
      where: { email: email.trim().toLowerCase(), status: 'pending' },
      data: {
        status: 'completed',
        handledBy: adminEmail,
        handledAt: new Date(),
      },
    });
  }
}

function receipt(row: DeletionRequestRow): DeletionRequestReceipt {
  return {
    id: row.id,
    status: row.status as DeletionRequestStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

function toRequest(row: DeletionRequestRow): DeletionRequest {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    verified: row.verified,
    reason: row.reason,
    status: row.status as DeletionRequestStatus,
    source: row.source as DeletionRequestSource,
    note: row.note,
    handledBy: row.handledBy,
    handledAt: row.handledAt ? row.handledAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
