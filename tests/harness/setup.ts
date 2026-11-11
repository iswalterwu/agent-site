import { afterAll } from "vitest";
import { removeTmpDirs } from "./wait";

// 每个测试文件结束后，删掉其中 mkTmpDir 建过的目录
afterAll(removeTmpDirs);
