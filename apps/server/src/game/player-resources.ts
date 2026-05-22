import type { Player, PlayerResources } from "./types.js";

const normalize = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export const resourceKeyForFeature = (feature: string): string | null => {
  const normalized = normalize(feature);
  if (normalized === "second wind" || normalized.includes("segundo folego")) return "second_wind";
  if (normalized === "action surge" || normalized.includes("surto de acao")) return "action_surge";
  if (normalized === "channel divinity") return "channel_divinity";
  if (normalized === "wild shape") return "wild_shape";
  if (normalized === "bardic inspiration") return "bardic_inspiration";
  return null;
};

export const defaultResourcesForFeatures = (features: string[]): PlayerResources => {
  const limited: PlayerResources["limited"] = {};

  for (const feature of features) {
    const key = resourceKeyForFeature(feature);
    if (!key) continue;
    limited[key] = {
      label: feature,
      used: 0,
      max: key === "bardic_inspiration" ? 2 : 1,
      recovery: "short_rest",
    };
  }

  return { limited, conditions: [] };
};

export const normalizePlayerResources = (player: Pick<Player, "features"> & Partial<Pick<Player, "resources">>): PlayerResources => {
  const defaults = defaultResourcesForFeatures(player.features ?? []);
  const existing = player.resources ?? { limited: {}, conditions: [] };
  const limited = { ...defaults.limited };

  for (const [key, value] of Object.entries(existing.limited ?? {})) {
    limited[key] = {
      label: value.label ?? defaults.limited[key]?.label ?? key,
      used: Math.max(0, Number(value.used ?? 0)),
      max: Math.max(1, Number(value.max ?? defaults.limited[key]?.max ?? 1)),
      recovery: value.recovery ?? defaults.limited[key]?.recovery ?? "short_rest",
    };
  }

  return {
    limited,
    conditions: Array.isArray(existing.conditions) ? existing.conditions.map(String) : [],
  };
};

export const formatResourceSummary = (resources: PlayerResources): string => {
  const limited = Object.values(resources.limited);
  const resourceText = limited.length > 0
    ? limited.map((resource) => `${resource.label} ${Math.max(0, resource.max - resource.used)}/${resource.max}`).join(", ")
    : "nenhum recurso limitado";
  const conditionText = resources.conditions.length > 0 ? resources.conditions.join(", ") : "nenhuma";
  return `recursos: ${resourceText}; condições: ${conditionText}`;
};

