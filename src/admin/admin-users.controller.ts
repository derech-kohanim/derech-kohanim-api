import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/auth.guard';
import { AdminUsersService } from './admin-users.service';
import { AdminEmail, AdminGuard } from './admin.guard';
import { UpdateUserDto, UsersQueryDto } from './admin.dto';
import type { AdminUserDetail, AdminUserList } from './admin.types';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, AdminGuard)
@Controller('api/admin/users')
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  @ApiOperation({
    summary: 'List accounts, newest first',
    description:
      'Each row carries the activity counts (sessions, routes, feedback) and the last time the ' +
      'account navigated. `search` matches email or display name.',
  })
  list(@Query() query: UsersQueryDto): Promise<AdminUserList> {
    return this.users.list(query.search, query.limit, query.offset);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One account with its saved data counts and recent sessions' })
  get(@Param('id') id: string): Promise<AdminUserDetail> {
    return this.users.get(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change an account tier or display name' })
  update(@Param('id') id: string, @Body() body: UpdateUserDto): Promise<AdminUserDetail> {
    return this.users.update(id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Delete an account',
    description:
      'Removes the account and its personal data (tokens, saved and recent places). Routes, ' +
      'sessions and feedback are kept but disowned. Admin accounts are refused.',
  })
  async remove(@Param('id') id: string, @AdminEmail() email: string): Promise<void> {
    await this.users.remove(id, email);
  }
}
