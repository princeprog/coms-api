import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  ScheduleExceptionDto,
  ShiftTemplateDto,
  StaffPatternDto,
  UpdateShiftTemplateDto,
} from './dto/schedule.dto';
import { isCalendarDate, weekStart } from './schedule-policy';
import { SchedulesRepository } from './schedules.repository';
import {
  ShiftTemplatesRepository,
  type ShiftTemplateInput,
} from './shift-templates.repository';

function templateInput(dto: ShiftTemplateDto): ShiftTemplateInput {
  const name = dto.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new BadRequestException('Enter a shift name');
  if (dto.start_time === dto.end_time)
    throw new BadRequestException('A shift must end at a different time');
  return {
    name,
    startTime: dto.start_time,
    endTime: dto.end_time,
    weekdays: [...dto.weekdays].sort((a, b) => a - b),
  };
}

function calendarDate(value: string) {
  if (!isCalendarDate(value))
    throw new BadRequestException('Choose a valid date');
  return value;
}

@Injectable()
export class SchedulesService {
  constructor(
    private readonly templates: ShiftTemplatesRepository,
    private readonly schedules: SchedulesRepository,
  ) {}

  listTemplates(branchId: string) {
    return this.templates.list(branchId);
  }

  createTemplate(branchId: string, dto: ShiftTemplateDto, actorUserId: string) {
    return this.templates.create(branchId, templateInput(dto), actorUserId);
  }

  updateTemplate(branchId: string, id: string, dto: UpdateShiftTemplateDto) {
    return this.templates.update(branchId, id, {
      ...templateInput(dto),
      revision: dto.revision,
    });
  }

  setTemplateActive(branchId: string, id: string, active: boolean) {
    return this.templates.setActive(branchId, id, active);
  }

  week(branchId: string, week?: string) {
    return this.schedules.week(
      branchId,
      week ? weekStart(calendarDate(week)) : null,
    );
  }

  replacePattern(branchId: string, userId: string, dto: StaffPatternDto) {
    const unique = new Map(
      dto.assignments.map((a) => [`${a.template_id}:${a.weekday}`, a]),
    );
    return this.schedules.replacePattern(branchId, userId, [
      ...unique.values(),
    ]);
  }

  addException(
    branchId: string,
    dto: ScheduleExceptionDto,
    actorUserId: string,
  ) {
    return this.schedules.addException(
      branchId,
      {
        userId: dto.user_id,
        templateId: dto.template_id,
        workDate: calendarDate(dto.work_date),
        kind: dto.kind,
        reason: dto.reason?.trim() || null,
      },
      actorUserId,
    );
  }

  removeException(branchId: string, exceptionId: string) {
    return this.schedules.removeException(branchId, exceptionId);
  }

  mine(userId: string) {
    return this.schedules.mine(userId);
  }
}
