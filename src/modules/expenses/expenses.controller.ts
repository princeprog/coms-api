import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { RequirePermission } from '../../common/decorators/access-policy.decorator';
import { CurrentAccessContext } from '../../common/decorators/current-access-context.decorator';
import { AccessControlGuard } from '../../common/guards/access-control.guard';
import { AuthGatewayGuard } from '../../common/guards/auth-gateway.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import type { AccessContext } from '../access-control/access-control.types';
import {
  CashOutQueryDto,
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ExpenseQueryDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
  VoidExpenseDto,
} from './dto/expense.dto';
import { ExpenseCategoriesService } from './expense-categories.service';
import { ExpenseMutationsService } from './expense-mutations.service';
import { ExpensesExportService } from './expenses-export.service';
import { ExpensesService } from './expenses.service';

@Controller('expenses')
@UseGuards(AuthGatewayGuard, AuthGuard, AccessControlGuard)
export class ExpensesController {
  constructor(
    private readonly service: ExpensesService,
    private readonly mutations: ExpenseMutationsService,
    private readonly categories: ExpenseCategoriesService,
    private readonly exports: ExpensesExportService,
  ) {}

  // ExpensesAccessService enforces branch scope for these mixed-location routes:
  // the generic branch decorator requires active assignments and cannot express
  // independent commissary/global grants or unchanged inactive history edits.
  @Get()
  @RequirePermission('expenses.read')
  list(
    @Query() query: ExpenseQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.list(query, access);
  }

  @Get('export')
  @RequirePermission('expenses.read')
  export(
    @Query() query: ExpenseQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.exports.export(query, access);
  }

  @Get('locations')
  @RequirePermission('expenses.read')
  locations(@CurrentAccessContext() access: AccessContext) {
    return this.service.locations(access);
  }

  @Get('cash-outs')
  @RequirePermission('expenses.read')
  cashOuts(
    @Query() query: CashOutQueryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.cashOuts(query, access);
  }

  @Get('categories')
  @RequirePermission('expenses.read')
  listCategories(@CurrentAccessContext() access: AccessContext) {
    return this.categories.list(access);
  }

  @Post('categories')
  @RequirePermission('expenses.categories_manage')
  createCategory(
    @Body() input: CreateExpenseCategoryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.categories.create(input, access);
  }

  @Patch('categories/:id')
  @RequirePermission('expenses.categories_manage')
  updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateExpenseCategoryDto,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.categories.update(id, input, access);
  }

  @Get('records/:source/:id')
  @RequirePermission('expenses.read')
  detail(
    @Param('source') source: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentAccessContext() access: AccessContext,
  ) {
    return this.service.detail(source, id, access);
  }

  @Post()
  @RequirePermission('expenses.create')
  create(
    @Body() input: CreateExpenseDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.mutations.create(input, access, key);
  }

  @Patch(':id')
  @RequirePermission('expenses.update')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateExpenseDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.mutations.update(id, input, access, key);
  }

  @Post(':id/void')
  @RequirePermission('expenses.void')
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: VoidExpenseDto,
    @CurrentAccessContext() access: AccessContext,
    @Headers('idempotency-key') key?: string,
  ) {
    return this.mutations.void(id, input, access, key);
  }
}
