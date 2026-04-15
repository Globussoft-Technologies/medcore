import { httpServer } from "./app";
import { registerScheduledTasks } from "./services/scheduled-tasks";

const PORT = process.env.PORT || 4000;
httpServer.listen(PORT, () => {
  console.log(`MedCore API running on port ${PORT}`);
  registerScheduledTasks();
});
