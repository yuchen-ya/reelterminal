/**
 * View-state store for the user-level material library panel.
 *
 * The canonical records live in the MaterialLibraryService (IndexedDB);
 * this store only holds the current page view model, filters, selection,
 * journal summary, and computed file-availability badges. Mutations go
 * through the service and then refresh() — the store never edits records
 * itself, so the serialized mutation lane and journal stay authoritative.
 */
import { create } from "zustand";
import type {
  MaterialFileStatus,
  MaterialJournalEntry,
  MaterialKind,
  MaterialRecord,
  MaterialSortOrder,
} from "@reelterminal/core";
import { getMaterialLibraryService } from "../services/material-library/library-service";
import { probeMaterialFileStatuses } from "../services/material-library/file-status";

export type MaterialStatusFilter = "all" | "inbox" | "organized";

export interface MaterialLibraryFilters {
  readonly kind: MaterialKind | "all";
  readonly status: MaterialStatusFilter;
  readonly tag: string | null;
  readonly query: string;
}

export interface MaterialLibraryState {
  loading: boolean;
  error: string | null;
  items: readonly MaterialRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  allTags: readonly string[];
  inboxCount: number;
  totalCount: number;
  filters: MaterialLibraryFilters;
  sort: MaterialSortOrder;
  selectedIds: readonly string[];
  journal: readonly MaterialJournalEntry[];
  fileStatuses: Readonly<Record<string, MaterialFileStatus>>;
  detailMaterialId: string | null;
  addDialog: "link" | "method" | null;
  segmentDialogMaterialId: string | null;

  refresh: (options?: { resetPage?: boolean }) => Promise<void>;
  refreshJournal: () => Promise<void>;
  setFilters: (partial: Partial<MaterialLibraryFilters>) => void;
  setSort: (sort: MaterialSortOrder) => void;
  setPage: (page: number) => void;
  loadMore: () => Promise<void>;
  toggleSelected: (id: string) => void;
  selectAllVisible: () => void;
  clearSelection: () => void;
  loadFileStatusesFor: (records: readonly MaterialRecord[]) => Promise<void>;
  openDetail: (id: string | null) => void;
  openAddDialog: (dialog: "link" | "method" | null) => void;
  openSegmentDialog: (materialId: string | null) => void;
}

const PAGE_SIZE = 40;

export const useMaterialLibraryStore = create<MaterialLibraryState>()(
  (set, get) => ({
    loading: false,
    error: null,
    items: [],
    total: 0,
    page: 1,
    pageSize: PAGE_SIZE,
    totalPages: 1,
    allTags: [],
    inboxCount: 0,
    totalCount: 0,
    filters: { kind: "all", status: "all", tag: null, query: "" },
    sort: "updated",
    selectedIds: [],
    journal: [],
    fileStatuses: {},
    detailMaterialId: null,
    addDialog: null,
    segmentDialogMaterialId: null,

    refresh: async (options) => {
      const state = get();
      set({ loading: true, error: null });
      const filters = state.filters;
      const result = await getMaterialLibraryService().list({
        page: options?.resetPage ? 1 : state.page,
        pageSize: PAGE_SIZE,
        ...(filters.kind !== "all" ? { kind: filters.kind } : {}),
        ...(filters.status !== "all"
          ? { status: filters.status as "inbox" | "organized" }
          : {}),
        ...(filters.tag ? { tag: filters.tag } : {}),
        ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
        sort: state.sort,
      });
      if (!result.ok) {
        set({ loading: false, error: result.message });
        return;
      }
      const counts = await getMaterialLibraryService().counts();
      set({
        loading: false,
        items: result.value.items,
        total: result.value.total,
        page: result.value.page,
        totalPages: result.value.totalPages,
        allTags: result.value.allTags,
        inboxCount: counts.ok ? counts.value.inbox : 0,
        totalCount: counts.ok ? counts.value.total : result.value.total,
        selectedIds: get().selectedIds.filter((id) =>
          result.value.items.some((item) => item.id === id),
        ),
      });
      void get().loadFileStatusesFor(result.value.items);
    },

    refreshJournal: async () => {
      const result = await getMaterialLibraryService().journal(20);
      if (result.ok) set({ journal: result.value });
    },

    setFilters: (partial) => {
      set({ filters: { ...get().filters, ...partial } });
      void get().refresh({ resetPage: true });
    },

    setSort: (sort) => {
      set({ sort });
      void get().refresh();
    },

    setPage: (page) => {
      const clamped = Math.min(Math.max(1, page), get().totalPages);
      set({ page: clamped });
      void get().refresh();
    },

    loadMore: async () => {
      const state = get();
      if (state.page >= state.totalPages) return;
      set({ page: state.page + 1, loading: true });
      const filters = state.filters;
      const result = await getMaterialLibraryService().list({
        page: state.page + 1,
        pageSize: PAGE_SIZE,
        ...(filters.kind !== "all" ? { kind: filters.kind } : {}),
        ...(filters.status !== "all"
          ? { status: filters.status as "inbox" | "organized" }
          : {}),
        ...(filters.tag ? { tag: filters.tag } : {}),
        ...(filters.query.trim() ? { query: filters.query.trim() } : {}),
        sort: state.sort,
      });
      if (!result.ok) {
        set({ loading: false, error: result.message });
        return;
      }
      set({
        loading: false,
        items: [...state.items, ...result.value.items],
        page: result.value.page,
        total: result.value.total,
        totalPages: result.value.totalPages,
      });
      void get().loadFileStatusesFor(result.value.items);
    },

    toggleSelected: (id) => {
      const current = get().selectedIds;
      set({
        selectedIds: current.includes(id)
          ? current.filter((selected) => selected !== id)
          : [...current, id],
      });
    },

    selectAllVisible: () => {
      set({ selectedIds: get().items.map((item) => item.id) });
    },

    clearSelection: () => set({ selectedIds: [] }),

    loadFileStatusesFor: async (records) => {
      const statuses = await probeMaterialFileStatuses(records);
      set({ fileStatuses: { ...get().fileStatuses, ...Object.fromEntries(statuses) } });
    },

    openDetail: (id) => set({ detailMaterialId: id }),
    openAddDialog: (dialog) => set({ addDialog: dialog }),
    openSegmentDialog: (materialId) => set({ segmentDialogMaterialId: materialId }),
  }),
);
