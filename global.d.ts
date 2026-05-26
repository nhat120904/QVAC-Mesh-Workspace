declare const Pear:
  | {
      app?: {
        storage?: string;
        name?: string;
        dev?: boolean;
      };
      teardown?: (fn: () => void | Promise<void>) => void;
    }
  | undefined;

interface GlobalThis {
  Pear?: typeof Pear;
}

interface File {
  path?: string;
}
