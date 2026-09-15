import type {
  Template,
  TemplateSummary,
  ScriptableTemplate,
} from "@openreel/core";

import { OPENREEL_CLOUD_ENABLED, OPENREEL_CLOUD_URL } from "../config/api-endpoints";
import { t } from "../i18n";

const CLOUD_API_URL = OPENREEL_CLOUD_URL;

export interface CloudTemplate extends TemplateSummary {
  author?: string;
}

export class TemplateCloudService {
  private apiUrl: string;

  constructor(apiUrl: string = CLOUD_API_URL) {
    this.apiUrl = apiUrl;
  }

  /**
   * Whether the first-party cloud is enabled in this build. When false,
   * every method below short-circuits before constructing a request,
   * and the UI is expected to explain the disabled state.
   */
  isCloudEnabled(): boolean {
    return OPENREEL_CLOUD_ENABLED;
  }

  private disabledError(): string {
    return t("templates.cloudActionUnavailable");
  }

  async listTemplates(): Promise<CloudTemplate[]> {
    if (!OPENREEL_CLOUD_ENABLED) return [];
    try {
      const response = await fetch(`${this.apiUrl}/templates`);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data.templates || [];
    } catch (error) {
      console.error("Failed to list templates from cloud:", error);
      return [];
    }
  }

  async getTemplate(id: string): Promise<Template | null> {
    if (!OPENREEL_CLOUD_ENABLED) return null;
    try {
      const response = await fetch(`${this.apiUrl}/templates/${id}`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error(`Failed to get template ${id} from cloud:`, error);
      return null;
    }
  }

  async uploadTemplate(
    template: Template,
  ): Promise<{ success: boolean; error?: string }> {
    if (!OPENREEL_CLOUD_ENABLED) {
      return { success: false, error: this.disabledError() };
    }
    try {
      const response = await fetch(`${this.apiUrl}/templates`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(template),
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || "Upload failed" };
      }

      return { success: true };
    } catch (error) {
      console.error("Failed to upload template to cloud:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Upload failed",
      };
    }
  }

  async deleteTemplate(
    id: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!OPENREEL_CLOUD_ENABLED) {
      return { success: false, error: this.disabledError() };
    }
    try {
      const response = await fetch(`${this.apiUrl}/templates/${id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        return { success: false, error: data.error || "Delete failed" };
      }

      return { success: true };
    } catch (error) {
      console.error(`Failed to delete template ${id} from cloud:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Delete failed",
      };
    }
  }

  async checkHealth(): Promise<boolean> {
    if (!OPENREEL_CLOUD_ENABLED) return false;
    try {
      const response = await fetch(`${this.apiUrl}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async listScriptableTemplates(): Promise<ScriptableTemplate[]> {
    if (!OPENREEL_CLOUD_ENABLED) return [];
    try {
      const response = await fetch(`${this.apiUrl}/templates/scriptable`);
      if (!response.ok) {
        return [];
      }
      const data = await response.json();
      return data.templates || [];
    } catch (error) {
      console.error("Failed to list scriptable templates from cloud:", error);
      return [];
    }
  }

  async getScriptableTemplate(id: string): Promise<ScriptableTemplate | null> {
    if (!OPENREEL_CLOUD_ENABLED) return null;
    try {
      const response = await fetch(`${this.apiUrl}/templates/scriptable/${id}`);
      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.json();
    } catch (error) {
      console.error(
        `Failed to get scriptable template ${id} from cloud:`,
        error,
      );
      return null;
    }
  }
}

export const templateCloudService = new TemplateCloudService();
