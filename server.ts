import express from "express";
import cors from "cors";
import leadsRouter from "./api/leads.routes";

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.use("/api", leadsRouter);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));