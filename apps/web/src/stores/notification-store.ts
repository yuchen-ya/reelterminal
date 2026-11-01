import { create } from "zustand";

export type NotificationType = "success" | "error" | "warning" | "info";

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message?: string;
  /** Built-in UI diagnostic copy; arbitrary notification content remains untouched. */
  localizeMessage?: boolean;
  duration?: number;
  dismissible?: boolean;
  /** Fires when the card body is activated (click or Enter/Space). */
  onClick?: () => void;
  onClickLabel?: string;
  /** Only app-owned action labels opt into localization; arbitrary labels stay verbatim. */
  localizeOnClickLabel?: boolean;
  /** Fires only when the user dismisses via X, never on programmatic removal. */
  onDismiss?: () => void;
}

interface NotificationState {
  notifications: Notification[];
  addNotification: (notification: Omit<Notification, "id">) => string;
  removeNotification: (id: string) => void;
  clearAll: () => void;
}

let notificationId = 0;

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],

  addNotification: (notification) => {
    const id = `notification-${++notificationId}`;
    const newNotification: Notification = {
      id,
      duration: 4000,
      dismissible: true,
      ...notification,
    };

    set((state) => ({
      notifications: [...state.notifications, newNotification],
    }));

    if (newNotification.duration && newNotification.duration > 0) {
      setTimeout(() => {
        get().removeNotification(id);
      }, newNotification.duration);
    }

    return id;
  },

  removeNotification: (id) => {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  clearAll: () => {
    set({ notifications: [] });
  },
}));

export const toast = {
  success: (title: string, message?: string, options?: Pick<Notification, "localizeMessage">) =>
    useNotificationStore
      .getState()
      .addNotification({ type: "success", title, message, localizeMessage: true, ...options }),
  error: (title: string, message?: string, options?: Pick<Notification, "localizeMessage">) =>
    useNotificationStore
      .getState()
      .addNotification({ type: "error", title, message, duration: 6000, localizeMessage: true, ...options }),
  warning: (title: string, message?: string, options?: Pick<Notification, "localizeMessage">) =>
    useNotificationStore
      .getState()
      .addNotification({ type: "warning", title, message, localizeMessage: true, ...options }),
  info: (title: string, message?: string, options?: Pick<Notification, "localizeMessage">) =>
    useNotificationStore
      .getState()
      .addNotification({ type: "info", title, message, localizeMessage: true, ...options }),
};
