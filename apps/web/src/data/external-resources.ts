/** Hand-maintained navigation only. No third-party code, assets or remote metadata. */
export const RESOURCE_CATEGORIES = ["all", "animation", "transitions", "captions", "fonts", "collections"] as const;
export type ResourceCategory = (typeof RESOURCE_CATEGORIES)[number];

interface ExternalResource {
  id: string;
  name: string;
  description: { en: string; zh: string };
  categories: Exclude<ResourceCategory, "all">[];
  tags: string[];
  url: string;
}

export const EXTERNAL_RESOURCES: readonly ExternalResource[] = [
  { id: "remotion", name: "Remotion Resources", categories: ["collections", "animation"], tags: ["React", "Remotion"], url: "https://www.remotion.dev/docs/resources",
    description: { en: "An index of Remotion templates, components, integrations and examples.", zh: "Remotion 模板、组件、集成与示例的资源索引。" } },
  { id: "rendercomp", name: "RenderComp", categories: ["animation"], tags: ["React", "Remotion"], url: "https://www.rendercomp.com/",
    description: { en: "Animation templates for the Remotion ecosystem.", zh: "面向 Remotion 生态的动画模板资源。" } },
  { id: "gl-transitions", name: "GL Transitions", categories: ["transitions"], tags: ["GLSL", "WebGL"], url: "https://github.com/gl-transitions/gl-transitions",
    description: { en: "A collection of GLSL transition effects.", zh: "GLSL 转场效果代码集合。" } },
  { id: "codrops", name: "Codrops", categories: ["animation", "collections"], tags: ["CSS", "JavaScript", "WebGL"], url: "https://tympanus.net/codrops/",
    description: { en: "Creative web effects, tutorials and interactive demos.", zh: "创意网页效果、教程与交互演示。" } },
  { id: "animista", name: "Animista", categories: ["animation"], tags: ["CSS"], url: "https://animista.net/",
    description: { en: "A playground for exploring and adjusting CSS animations.", zh: "可浏览和调整参数的 CSS 动画示例。" } },
  { id: "react-bits", name: "React Bits", categories: ["animation", "captions"], tags: ["React", "CSS"], url: "https://reactbits.dev/",
    description: { en: "Animated React text, backgrounds and interactive components.", zh: "React 文字动画、动态背景与交互组件。" } },
  { id: "remotion-captions", name: "Remotion TikTok Template", categories: ["captions"], tags: ["React", "Remotion", "subtitles", "字幕"], url: "https://www.remotion.dev/templates",
    description: { en: "Find Remotion’s word-by-word caption starter among its templates.", zh: "在 Remotion 模板目录中查看逐字字幕入门模板。" } },
  { id: "google-fonts", name: "Google Fonts", categories: ["fonts"], tags: ["Typography", "字体"], url: "https://fonts.google.com/",
    description: { en: "Browse font families and their individual license information.", zh: "浏览字体家族及各自的许可信息。" } },
];
