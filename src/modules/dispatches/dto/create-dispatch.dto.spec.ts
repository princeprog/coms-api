import 'reflect-metadata';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';
import { SendDispatchDto, SendDispatchDraftDto } from './create-dispatch.dto';

describe.each([SendDispatchDto, SendDispatchDraftDto])(
  '%s arrival timezone',
  (Dto) => {
    it.each([
      '2027-01-01T12:30:00Z',
      '2027-01-01T20:30:00+08:00',
      '2027-01-01T04:30:00-08:00',
      undefined,
    ])(
      'accepts an explicit instant or the server default: %s',
      async (receive_by) => {
        const errors = await validate(Object.assign(new Dto(), { receive_by }));
        expect(
          errors.filter((error) => error.property === 'receive_by'),
        ).toEqual([]);
      },
    );
    it.each([
      '2027-01-01',
      '2027-01-01T20:30:00',
      'invalid',
      '2027-02-30T20:30:00Z',
    ])('rejects ambiguous or invalid datetimes: %s', async (receive_by) => {
      const errors = await validate(Object.assign(new Dto(), { receive_by }));
      expect(errors.some((error) => error.property === 'receive_by')).toBe(
        true,
      );
    });
  },
);
