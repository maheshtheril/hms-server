import { EventEmitter } from "events";
export const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(50); // safe default
