/**
 * Message templates (docs/sms.md §6): the validation and read model behind
 * `/v1/message-templates`. Pure — the routes own the database and the audit
 * trail, this file owns "is this a template we are willing to store".
 *
 * The one rule worth stating out loud: a body is rejected at WRITE time when
 * it references a merge field nobody knows. That is the only place loud
 * failure belongs. At send time the renderer is total (core
 * `renderMessageBody`) because discovering a typo mid-conversation, by
 * texting a seller `Hi {frist_name}`, is strictly worse than an empty gap.
 */

import { z } from 'zod';
import { findMessageMergeFields, unknownMessageMergeFields } from '@talkr/core';
import type { schema } from '@talkr/db';

export const TEMPLATE_NAME_MAX = 120;
/** The send path's own body cap (one message, up to ~11 segments). */
export const TEMPLATE_BODY_MAX = 1600;

const nameField = z.string().trim().min(1).max(TEMPLATE_NAME_MAX);
const bodyField = z
  .string()
  .min(1)
  .max(TEMPLATE_BODY_MAX)
  .refine((b) => b.trim().length > 0, { message: 'body cannot be blank' });
/** Display grouping only — unvalidated against a list, by design (schema.ts). */
const categoryField = z.string().trim().min(1).max(40).nullable();

export const templateCreateSchema = z.object({
  name: nameField,
  body: bodyField,
  category: categoryField.optional(),
  is_active: z.boolean().optional(),
});

export const templatePatchSchema = z
  .object({
    name: nameField.optional(),
    body: bodyField.optional(),
    category: categoryField.optional(),
    is_active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;
export type TemplatePatchInput = z.infer<typeof templatePatchSchema>;

export interface UnknownMergeFieldProblem {
  error: 'unknown_merge_field';
  /** Exactly which names are wrong — the UI highlights them. */
  fields: string[];
  message: string;
}

/**
 * Null when the body only uses fields the renderer knows, otherwise the
 * rejection (with the offending names listed, because "invalid body" sends a
 * manager hunting through 1600 characters).
 */
export function templateBodyProblem(body: string): UnknownMergeFieldProblem | null {
  const unknown = unknownMessageMergeFields(body);
  if (unknown.length === 0) return null;
  return {
    error: 'unknown_merge_field',
    fields: unknown,
    message: `unknown merge ${unknown.length === 1 ? 'field' : 'fields'}: ${unknown
      .map((f) => `{${f}}`)
      .join(' ')}`,
  };
}

/** The merge fields a body uses, for the template card. */
export function templateMergeFields(body: string): string[] {
  return findMessageMergeFields(body);
}

export type MessageTemplateRow = typeof schema.messageTemplates.$inferSelect;

export interface MessageTemplateDto {
  id: string;
  name: string;
  body: string;
  category: string | null;
  is_active: boolean;
  /** Sends that used this template — counted from messages, never denormalized. */
  use_count: number;
  merge_fields: string[];
  created_at: Date;
}

export function serializeTemplate(row: MessageTemplateRow, useCount: number): MessageTemplateDto {
  return {
    id: row.id,
    name: row.name,
    body: row.body,
    category: row.category,
    is_active: row.isActive,
    use_count: useCount,
    merge_fields: templateMergeFields(row.body),
    created_at: row.createdAt,
  };
}
