declare namespace chrome {
  namespace runtime {
    interface RuntimeError {
      message?: string;
    }

    const lastError: RuntimeError | undefined;

    function getURL(path: string): string;

    function sendMessage<TMessage = unknown, TResponse = unknown>(
      message: TMessage,
      callback?: (response: TResponse) => void,
    ): void;

    const onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
      removeListener(
        callback: (
          message: unknown,
          sender: MessageSender,
          sendResponse: (response?: unknown) => void,
        ) => boolean | void,
      ): void;
    };

    interface MessageSender {
      tab?: tabs.Tab;
      frameId?: number;
      id?: string;
      url?: string;
    }
  }

  namespace tabs {
    interface Tab {
      id?: number;
      url?: string;
      title?: string;
      windowId?: number;
      favIconUrl?: string;
    }

    interface QueryInfo {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }

    interface TabChangeInfo {
      status?: 'loading' | 'complete';
      url?: string;
    }

    function query(queryInfo: QueryInfo, callback: (tabs: Tab[]) => void): void;

    function captureVisibleTab(
      windowId?: number,
      options?: { format?: 'png' | 'jpeg'; quality?: number },
      callback?: (dataUrl?: string) => void,
    ): void;

    function captureVisibleTab(
      options?: { format?: 'png' | 'jpeg'; quality?: number },
      callback?: (dataUrl?: string) => void,
    ): void;

    function sendMessage<TMessage = unknown, TResponse = unknown>(
      tabId: number,
      message: TMessage,
      callback?: (response: TResponse) => void,
    ): void;

    const onUpdated: {
      addListener(callback: (tabId: number, changeInfo: TabChangeInfo, tab: Tab) => void): void;
    };
  }

  namespace scripting {
    interface InjectionTarget {
      tabId: number;
      allFrames?: boolean;
      frameIds?: number[];
    }

    function executeScript(
      injection: { target: InjectionTarget; files?: string[]; func?: (...args: never[]) => unknown; args?: unknown[] },
      callback?: (results?: unknown[]) => void,
    ): void;
  }

  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }

    const onChanged: {
      addListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
      removeListener(callback: (changes: Record<string, StorageChange>, areaName: string) => void): void;
    };

    namespace local {
      function get(
        keys: string | string[] | Record<string, unknown> | null,
        callback: (items: Record<string, unknown>) => void,
      ): void;

      function set(items: Record<string, unknown>, callback?: () => void): void;

      function remove(keys: string | string[], callback?: () => void): void;
    }
  }
}
