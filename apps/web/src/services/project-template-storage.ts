import { TemplateEngine } from "@reelterminal/core";

// Keep the existing template database; UI and cleanup both read durable rows.
export const projectTemplateStorage = new TemplateEngine();
