import { Router, type IRouter } from "express";
import healthRouter from "./health";
import batchRouter from "./batches";
import calendarRouter from "./calendar";
import dispatchRouter from "./dispatches";
import employeeRouter from "./employees";
import lockRouter, { requireDemoLease } from "./lock";
import operationsRouter from "./operations";
import settingsRouter from "./settings";
import timesheetRouter from "./timesheets";

const router: IRouter = Router();

router.use(healthRouter);
router.use(lockRouter);
router.use(requireDemoLease);
router.use(batchRouter);
router.use(calendarRouter);
router.use(dispatchRouter);
router.use(employeeRouter);
router.use(operationsRouter);
router.use(settingsRouter);
router.use(timesheetRouter);

export default router;
