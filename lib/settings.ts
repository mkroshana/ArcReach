import type { GlobalSettings, Prisma } from '@prisma/client';
import { prisma } from './db';

/** GlobalSettings is a single row stored under this fixed primary key. Every
 * reader and writer goes through the helpers below instead of findFirst(), so
 * admin saves always land on the row the send engine reads. */
export const GLOBAL_SETTINGS_ID = 'global';

type SettingsDefaults = Omit<Prisma.GlobalSettingsCreateInput, 'id'>;

/**
 * Returns the settings row, or null when none exists yet.
 *
 * A database created before the fixed id holds a uuid-keyed row (possibly
 * several, from concurrent first loads). The most recently updated one is the
 * last admin save, so it is re-keyed to 'global' and used from then on.
 */
export async function getGlobalSettings(): Promise<GlobalSettings | null> {
  const settings = await prisma.globalSettings.findUnique({ where: { id: GLOBAL_SETTINGS_ID } });
  if (settings) return settings;

  const legacy = await prisma.globalSettings.findFirst({
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
  });
  if (!legacy) return null;

  try {
    return await prisma.globalSettings.update({
      where: { id: legacy.id },
      data: { id: GLOBAL_SETTINGS_ID },
    });
  } catch (err) {
    // A concurrent request re-keyed a legacy row first; use the one it kept.
    const adopted = await prisma.globalSettings.findUnique({ where: { id: GLOBAL_SETTINGS_ID } });
    if (adopted) return adopted;
    throw err;
  }
}

/** Returns the settings row, creating it from `defaults` on first use. */
export async function ensureGlobalSettings(defaults: SettingsDefaults): Promise<GlobalSettings> {
  const existing = await getGlobalSettings();
  if (existing) return existing;

  try {
    return await prisma.globalSettings.create({ data: { ...defaults, id: GLOBAL_SETTINGS_ID } });
  } catch (err) {
    // A concurrent first load created the row between our read and this insert.
    const created = await prisma.globalSettings.findUnique({ where: { id: GLOBAL_SETTINGS_ID } });
    if (created) return created;
    throw err;
  }
}

/** Applies `update` to the settings row, or creates it from `create` if none exists. */
export async function saveGlobalSettings(
  update: Prisma.GlobalSettingsUpdateInput,
  create: SettingsDefaults,
): Promise<GlobalSettings> {
  // Adopt a legacy uuid-keyed row first so the upsert doesn't strand its values.
  await getGlobalSettings();
  return prisma.globalSettings.upsert({
    where: { id: GLOBAL_SETTINGS_ID },
    update,
    create: { ...create, id: GLOBAL_SETTINGS_ID },
  });
}
