import { Router, type IRouter } from "express";
import healthRouter from "./health";
import shortcutsRouter from "./shortcuts";
import learningRouter from "./learning";

const router: IRouter = Router();

router.use(healthRouter);
router.use(shortcutsRouter);
router.use(learningRouter);

export default router;
