import { z } from 'zod';

export const idleSettingsSchema = z
  .object({
    minutes: z.union([
      z.literal(0),
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(30),
      z.literal(60),
    ]),
    notifications: z.boolean(),
  })
  .strict();
export type IdleSettings = z.infer<typeof idleSettingsSchema>;
export type IdleState = {
  phase: 'active' | 'warning' | 'shielded';
  seconds: number;
  settings: IdleSettings;
  reason: 'idle' | 'manual' | 'os-lock' | 'sleep' | 'clock-change';
  settingsError?: string;
};
export const defaultIdleSettings: IdleSettings = { minutes: 0, notifications: false };
