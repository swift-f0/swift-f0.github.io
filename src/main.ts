import "./main.css";

import { createApp } from "vue";
import App from "./App.vue";

const legacy = /^#how(?:-|$)/.exec(location.hash);
if (legacy && !location.pathname.startsWith("/how")) {
  location.replace(`/how/${location.hash === "#how" ? "" : location.hash}`);
} else {
  createApp(App).mount("#app");
}
