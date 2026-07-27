export const normalizePath = (path: string): string => path;

export class Component {}

type TestElementOptions = {
  text?: string;
};

class TestElement {
  readonly children: TestElement[] = [];
  readonly tagName: string;
  value = "";
  inputMode = "";
  autocomplete = "";
  autocapitalize = "";
  spellcheck = true;
  maxLength = -1;
  disabled = false;
  private ownText = "";
  private readonly listeners = new Map<string, Array<(event: Event) => void>>();

  constructor(tagName: string, options: TestElementOptions = {}) {
    this.tagName = tagName.toUpperCase();
    this.ownText = options.text ?? "";
  }

  get textContent(): string {
    return `${this.ownText}${this.children
      .map((child) => child.textContent)
      .join("")}`;
  }

  set textContent(value: string) {
    this.ownText = value;
  }

  empty(): void {
    this.children.length = 0;
    this.ownText = "";
  }

  createEl(tagName: string, options: TestElementOptions = {}): TestElement {
    const child = new TestElement(tagName, options);
    this.children.push(child);
    return child;
  }

  appendChild(child: TestElement): TestElement {
    this.children.push(child);
    return child;
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event);
    }
    return true;
  }

  focus(): void {}

  querySelector(selector: string): TestElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): TestElement[] {
    const tagName = selector.toUpperCase();
    return this.children.flatMap((child) => [
      ...(child.tagName === tagName ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
}

export class MarkdownRenderChild extends Component {
  constructor(public readonly containerEl: HTMLElement) {
    super();
  }
}

export const Platform = {
  isDesktopApp: true,
  isLinux: false,
  isMacOS: true,
  isWin: false,
};

export class Modal {
  readonly contentEl = new TestElement("div");
  readonly titleEl = new TestElement("div");

  constructor(readonly app: unknown) {}

  open(): void {
    this.onOpen();
  }

  close(): void {
    this.onClose();
  }

  setTitle(title: string): this {
    this.titleEl.textContent = title;
    return this;
  }

  onOpen(): void {}

  onClose(): void {}
}

export class ButtonComponent {
  readonly buttonEl = new TestElement("button");
  private onClickCallback: (() => void) | null = null;

  constructor(containerEl: TestElement) {
    containerEl.appendChild(this.buttonEl);
    this.buttonEl.addEventListener("click", () => this.onClickCallback?.());
  }

  setCta(): this {
    return this;
  }

  setButtonText(text: string): this {
    this.buttonEl.textContent = text;
    return this;
  }

  setDisabled(disabled: boolean): this {
    this.buttonEl.disabled = disabled;
    return this;
  }

  onClick(callback: () => void): this {
    this.onClickCallback = callback;
    return this;
  }
}

export class TextComponent {
  readonly inputEl = new TestElement("input");

  constructor(containerEl: TestElement) {
    containerEl.appendChild(this.inputEl);
  }

  setPlaceholder(_placeholder: string): this {
    return this;
  }

  setValue(value: string): this {
    this.inputEl.value = value;
    return this;
  }

  onChange(callback: (value: string) => void): this {
    this.inputEl.addEventListener("input", () => callback(this.inputEl.value));
    return this;
  }
}

export class Setting {
  readonly settingEl: TestElement;

  constructor(containerEl: TestElement) {
    this.settingEl = containerEl.createEl("div");
  }

  setName(name: string): this {
    this.settingEl.createEl("span", { text: name });
    return this;
  }

  addText(callback: (text: TextComponent) => void): this {
    callback(new TextComponent(this.settingEl));
    return this;
  }

  addButton(callback: (button: ButtonComponent) => void): this {
    callback(new ButtonComponent(this.settingEl));
    return this;
  }
}

export class Notice {
  constructor(readonly message: string) {}
}

export class TFile {}
