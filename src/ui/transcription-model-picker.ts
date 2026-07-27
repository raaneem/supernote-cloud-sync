import type { DropdownComponent, Setting } from "obsidian";

import type { ApiModelOption } from "../ocr/api-models";

interface ModelPickerOptions {
  value: string;
  onChange: (value: string) => void | Promise<void>;
}

const CLAUDE_MODELS: ReadonlyArray<{
  value: string;
  label: string;
}> = [
  { value: "", label: "Default" },
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

const claudeAlias = (value: string): boolean =>
  CLAUDE_MODELS.some((option) => option.value !== "" && option.value === value);

const removeOption = (
  dropdown: DropdownComponent,
  value: string | null,
): void => {
  if (!value) {
    return;
  }
  const option = [...dropdown.selectEl.options].find(
    (candidate) => candidate.value === value,
  );
  option?.remove();
};

const replaceCustomOption = (
  dropdown: DropdownComponent,
  previous: string | null,
  next: string,
): string | null => {
  if (previous !== next) {
    removeOption(dropdown, previous);
  }
  let customOption = previous === next ? previous : null;
  const exists = [...dropdown.selectEl.options].some(
    (option) => option.value === next,
  );
  if (next && !exists) {
    dropdown.addOption(next, next);
    customOption = next;
  }
  dropdown.setValue(next);
  return customOption;
};

export const addClaudeModelPicker = (
  setting: Setting,
  options: ModelPickerOptions,
): void => {
  let value = options.value;
  let customInput: HTMLInputElement | null = null;
  let modelDropdown: DropdownComponent | null = null;
  let customOption = value && !claudeAlias(value) ? value : null;
  setting
    .addDropdown((dropdown) => {
      modelDropdown = dropdown;
      for (const option of CLAUDE_MODELS) {
        dropdown.addOption(option.value, option.label);
      }
      if (value && !claudeAlias(value)) {
        dropdown.addOption(value, value);
      }
      dropdown.setValue(value).onChange((next) => {
        if (customOption && next !== customOption) {
          removeOption(dropdown, customOption);
          customOption = null;
        }
        value = next;
        if (customInput) {
          customInput.value = next && !claudeAlias(next) ? next : "";
        }
        void options.onChange(next);
      });
    })
    .addText((text) => {
      customInput = text.inputEl;
      text
        .setValue(value && !claudeAlias(value) ? value : "")
        .setPlaceholder("Custom model ID")
        .onChange((next) => {
          const custom = next.trim();
          value = custom;
          if (modelDropdown) {
            if (claudeAlias(custom)) {
              removeOption(modelDropdown, customOption);
              customOption = null;
              modelDropdown.setValue(custom);
            } else {
              customOption = replaceCustomOption(
                modelDropdown,
                customOption,
                custom,
              );
            }
          }
          void options.onChange(custom);
        });
    });
};

export const addApiModelPicker = (
  setting: Setting,
  options: ModelPickerOptions & {
    loadModels: () => Promise<readonly ApiModelOption[]>;
  },
): void => {
  let value = options.value;
  let customInput: HTMLInputElement | null = null;
  let modelDropdown: DropdownComponent | null = null;
  let customOption = value || null;
  setting
    .addDropdown((dropdown) => {
      modelDropdown = dropdown;
      dropdown.addOption("", "Default");
      if (value) {
        dropdown.addOption(value, value);
      }
      dropdown.setValue(value).onChange((next) => {
        if (customOption && next !== customOption) {
          removeOption(dropdown, customOption);
          customOption = null;
        }
        value = next;
        if (customInput) {
          customInput.value = "";
        }
        void options.onChange(next);
      });
      let loaded = false;
      const loadModels = (): void => {
        if (loaded) {
          return;
        }
        loaded = true;
        void options.loadModels().then((models) => {
          if (
            customOption &&
            models.some((model) => model.id === customOption)
          ) {
            removeOption(dropdown, customOption);
            customOption = null;
          }
          for (const model of models) {
            dropdown.addOption(model.id, model.name);
          }
          dropdown.setValue(value);
        });
      };
      dropdown.selectEl.addEventListener("pointerdown", loadModels);
      dropdown.selectEl.addEventListener("focus", loadModels);
    })
    .addText((text) => {
      customInput = text.inputEl;
      text
        .setValue(value)
        .setPlaceholder("Custom model ID")
        .onChange((next) => {
          const custom = next.trim();
          value = custom;
          if (modelDropdown) {
            customOption = replaceCustomOption(
              modelDropdown,
              customOption,
              custom,
            );
          }
          void options.onChange(custom);
        });
    });
};
