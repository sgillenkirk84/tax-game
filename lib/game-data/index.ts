import workbookData from "./workbook-data.json";
import { validateGameDataset } from "./validate.mjs";
import type { GameDataset } from "./types";

export const GAME_DATA: GameDataset = workbookData;
export const GAME_DATA_VALIDATION = validateGameDataset(GAME_DATA);
