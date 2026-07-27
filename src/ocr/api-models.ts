export interface ApiModelOption {
  id: string;
  name: string;
}

interface JsonObject {
  [key: string]: unknown;
}

const asObject = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;

export const parseApiModels = (payload: unknown): ApiModelOption[] => {
  const root = asObject(payload);
  const entries = Array.isArray(root?.data) ? root.data : [];
  const models: ApiModelOption[] = [];
  for (const entry of entries) {
    const model = asObject(entry);
    if (typeof model?.id !== "string" || !model.id.trim()) {
      continue;
    }
    const architecture = asObject(model.architecture);
    const modalities = architecture?.input_modalities;
    if (Array.isArray(modalities) && !modalities.includes("image")) {
      continue;
    }
    models.push({
      id: model.id,
      name:
        typeof model.name === "string" && model.name.trim()
          ? model.name
          : model.id,
    });
  }
  return models.sort((left, right) => left.name.localeCompare(right.name));
};

export class ApiModelCatalog {
  private readonly cache = new Map<
    string,
    Promise<readonly ApiModelOption[]>
  >();

  load(
    baseUrl: string,
    fetchModels: () => Promise<unknown>,
  ): Promise<readonly ApiModelOption[]> {
    let pending = this.cache.get(baseUrl);
    if (!pending) {
      pending = fetchModels()
        .then(parseApiModels)
        .catch(() => []);
      this.cache.set(baseUrl, pending);
    }
    return pending;
  }
}
