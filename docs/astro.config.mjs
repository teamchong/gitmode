import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://teamchong.github.io",
  base: "/gitmode",
  integrations: [
    starlight({
      title: "gitmode",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/teamchong/gitmode",
        },
      ],
      sidebar: [
        { label: "Overview", slug: "index" },
        { label: "Getting Started", slug: "getting-started" },
        { label: "Architecture", slug: "architecture" },
        { label: "REST API", slug: "rest-api" },
        { label: "Git Protocol", slug: "git-protocol" },
        { label: "SSH Transport", slug: "ssh-transport" },
        { label: "WASM Engine", slug: "wasm-engine" },
        { label: "Performance", slug: "performance" },
        { label: "Scaling", slug: "scaling" },
        { label: "Deployment", slug: "deployment" },
      ],
    }),
  ],
});
