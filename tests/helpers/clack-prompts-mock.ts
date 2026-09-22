import { mock } from 'bun:test';

export const CLACK_CANCEL = Symbol('clack-cancel');
export const installScopeResponses: Array<
  'project' | 'user' | typeof CLACK_CANCEL
> = [];
export const installClientResponses: Array<
  string[] | typeof CLACK_CANCEL
> = [];
export const installConfirmationResponses: Array<
  boolean | typeof CLACK_CANCEL
> = [];
export const updateSelectResponses: string[] = [];

export const installNoteMock = mock(
  (_message: string, _title?: string) => {},
);
export const updateNoteMock = mock(
  (_message: string, _title?: string) => {},
);
export const installConfirmMock = mock(
  async (_options: { initialValue: boolean }) =>
    installConfirmationResponses.shift() ?? CLACK_CANCEL,
);
export const updateSelectMock = mock(
  async () => updateSelectResponses.shift() ?? '__back__',
);

export const spinnerStartMock = mock((_message?: string) => {});
export const spinnerMessageMock = mock((_message?: string) => {});
export const spinnerStopMock = mock((_message?: string) => {});
export const spinnerErrorMock = mock((_message?: string) => {});

const spinner = {
  start: spinnerStartMock,
  message: spinnerMessageMock,
  stop: spinnerStopMock,
  error: spinnerErrorMock,
};

mock.module('@clack/prompts', () => ({
  autocomplete: mock(async () => ''),
  autocompleteMultiselect: mock(
    async () => installClientResponses.shift() ?? CLACK_CANCEL,
  ),
  confirm: mock(async (options: { message?: string; initialValue: boolean }) =>
    options.message === 'Install with this target?'
      ? installConfirmMock(options)
      : false,
  ),
  isCancel: (value: unknown) => value === CLACK_CANCEL,
  isCI: () => false,
  multiselect: mock(async () => []),
  note: mock((message: string, title?: string) => {
    if (title === 'Install summary' || title?.startsWith('Installed: ')) {
      installNoteMock(message, title);
    } else updateNoteMock(message, title);
  }),
  select: mock(async (options: { message?: string }) =>
    options.message === 'Install scope'
      ? (installScopeResponses.shift() ?? CLACK_CANCEL)
      : updateSelectMock(),
  ),
  spinner: () => spinner,
  text: mock(async () => ''),
}));

function resetSpinnerMocks(): void {
  spinnerStartMock.mockClear();
  spinnerMessageMock.mockClear();
  spinnerStopMock.mockClear();
  spinnerErrorMock.mockClear();
}

export function resetInstallPromptMocks(): void {
  installScopeResponses.length = 0;
  installClientResponses.length = 0;
  installConfirmationResponses.length = 0;
  installNoteMock.mockClear();
  installConfirmMock.mockClear();
  resetSpinnerMocks();
}

export function resetUpdatePromptMocks(): void {
  updateSelectResponses.length = 0;
  updateNoteMock.mockClear();
  updateSelectMock.mockClear();
  resetSpinnerMocks();
}
