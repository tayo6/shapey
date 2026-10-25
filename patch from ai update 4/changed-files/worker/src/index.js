// Shapey Worker entry point. The public router lives in router.js; the Room Durable
// Object class is composed in room.js. Both are re-exported here because wrangler binds
// main = src/index.js and the durable_objects binding looks for the Room export.
export { default } from "./router.js";
export { Room } from "./room.js";
