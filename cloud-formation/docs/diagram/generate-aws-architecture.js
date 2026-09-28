// Generates aws-architecture.drawio (draw.io AWS shapes) from the layout below.
// Usage: node generate-aws-architecture.js [output.drawio]
const fs = require("fs");
const path = require("path");
const OUT = process.argv[2] || path.join(__dirname, "aws-architecture.drawio");
const cells = [];
let _id = 1;
const nid = () => `c${++_id}`;
const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const PTS = "points=[[0,0,0],[0.25,0,0],[0.5,0,0],[0.75,0,0],[1,0,0],[0,1,0],[0.25,1,0],[0.5,1,0],[0.75,1,0],[1,1,0],[0,0.25,0],[0,0.5,0],[0,0.75,0],[1,0.25,0],[1,0.5,0],[1,0.75,0]];";
const GPTS = "points=[[0,0],[0.25,0],[0.5,0],[0.75,0],[1,0],[1,0.25],[1,0.5],[1,0.75],[1,1],[0.75,1],[0.5,1],[0.25,1],[0,1],[0,0.75],[0,0.5],[0,0.25]];";

function vertex(x, y, w, h, value, style) {
  const i = nid();
  cells.push(`<mxCell id="${i}" value="${esc(value)}" style="${style}" vertex="1" parent="1"><mxGeometry x="${x}" y="${y}" width="${w}" height="${h}" as="geometry"/></mxCell>`);
  return i;
}
function edge(src, dst, value = "", color = "#232F3E", dashed = false, extra = "") {
  const i = nid();
  const st = `edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;endArrow=block;endFill=1;strokeWidth=2;strokeColor=${color};` +
    `fontColor=${color};fontSize=11;labelBackgroundColor=#FFFFFF;${dashed ? "dashed=1;" : ""}${extra}`;
  cells.push(`<mxCell id="${i}" value="${esc(value)}" style="${st}" edge="1" parent="1" source="${src}" target="${dst}"><mxGeometry relative="1" as="geometry"/></mxCell>`);
  return i;
}

// ---- icon helpers (draw.io AWS 2017+ "aws4" library) ----
const resIcon = (x, y, label, icon, color, size = 60) => vertex(x, y, size, size, label,
  PTS + `outlineConnect=0;fontColor=#232F3E;fillColor=${color};strokeColor=#ffffff;dashed=0;verticalLabelPosition=bottom;` +
  `verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=0;aspect=fixed;shape=mxgraph.aws4.resourceIcon;resIcon=mxgraph.aws4.${icon};`);
const shapeIcon = (x, y, w, h, label, shape, color) => vertex(x, y, w, h, label,
  `sketch=0;outlineConnect=0;fontColor=#232F3E;gradientColor=none;fillColor=${color};strokeColor=none;dashed=0;` +
  `verticalLabelPosition=bottom;verticalAlign=top;align=center;html=1;fontSize=11;fontStyle=0;aspect=fixed;pointerEvents=1;shape=mxgraph.aws4.${shape};`);
const group = (x, y, w, h, label, grIcon, stroke, { fill = "none", font = null, dashed = 0, extra = "" } = {}) => vertex(x, y, w, h, label,
  GPTS + `outlineConnect=0;gradientColor=none;html=1;whiteSpace=wrap;fontSize=12;fontStyle=1;container=0;pointerEvents=0;collapsible=0;recursiveResize=0;` +
  `shape=mxgraph.aws4.group;grIcon=mxgraph.aws4.${grIcon};strokeColor=${stroke};fillColor=${fill};verticalAlign=top;align=left;spacingLeft=30;` +
  `fontColor=${font || stroke};dashed=${dashed};${extra}`);
const box = (x, y, w, h, label, stroke, { fill = "none", dashed = 1, font = null, align = "center", extra = "" } = {}) => vertex(x, y, w, h, label,
  `rounded=0;fillColor=${fill};strokeColor=${stroke};dashed=${dashed};verticalAlign=top;align=${align};fontStyle=1;fontSize=12;` +
  `fontColor=${font || stroke};whiteSpace=wrap;html=1;spacingLeft=6;${extra}`);
const text = (x, y, w, h, label, size = 11, color = "#232F3E", align = "left") => vertex(x, y, w, h, label,
  `text;html=1;whiteSpace=wrap;align=${align};verticalAlign=top;fontSize=${size};fontColor=${color};`);

const ORANGE = "#ED7100", PURPLE = "#C925D1", NET = "#8C4FFF", PINK = "#E7157B", RED = "#DD344C";
const CAT = "#147EBA", CART = "#3F8624"; // colour per microservice

// ---- title ----
text(40, 10, 1600, 30, `<b>webstore</b> — dev environment on AWS (ECS Fargate · 2 microservices: <font color='${CAT}'>webstore-catalog</font> ×3 tasks, <font color='${CART}'>webstore-cart</font> ×5 tasks)`, 18);

// ---- outer groups ----
group(170, 60, 1900, 1370, "AWS Cloud", "group_aws_cloud_alt", "#232F3E");
group(200, 100, 1840, 1310, "AWS Region", "group_region", "#00A4A6", { font: "#147EBA", dashed: 1 });
group(230, 160, 1000, 980, "VPC  dev-webstore-vpc  (10.0.0.0/16)", "group_vpc2", NET);

box(260, 230, 450, 890, "Availability Zone A", "#147EBA", { extra: "fontStyle=0;" });
box(750, 230, 450, 890, "Availability Zone B", "#147EBA", { extra: "fontStyle=0;" });

const pubStyle = { fill: "#F2F6E8", font: "#248814", extra: "grStroke=0;" };
const privStyle = { fill: "#E6F6F7", font: "#147EBA", extra: "grStroke=0;" };
group(280, 270, 410, 200, "Public subnet A  10.0.0.0/24", "group_security_group", "#7AA116", pubStyle);
group(770, 270, 410, 200, "Public subnet B  10.0.1.0/24", "group_security_group", "#7AA116", pubStyle);
group(280, 510, 410, 590, "Private subnet A  10.0.10.0/24", "group_security_group", "#00A4A6", privStyle);
group(770, 510, 410, 590, "Private subnet B  10.0.11.0/24", "group_security_group", "#00A4A6", privStyle);

// ECS cluster spans both private subnets
const cluster = box(295, 555, 870, 530, "", ORANGE, { extra: "strokeWidth=2;" });
resIcon(305, 565, "", "ecs", ORANGE, 32);
text(342, 562, 800, 40, "<b>ECS Cluster  dev-webstore-cluster</b>  (Fargate, shared)<br><font color='#DD3522'>sg-ecs: inbound 8080 from sg-alb only</font>", 11, ORANGE);

// ---- edge / networking ----
const users = shapeIcon(60, 200, 60, 60, "Users<br>(Internet)", "users", "#232F3D");
const igw = shapeIcon(700, 135, 50, 50, "", "internet_gateway", NET);
text(760, 138, 160, 40, "Internet Gateway", 11, NET);
const nat = shapeIcon(320, 330, 60, 60, "NAT Gateway", "nat_gateway", NET);

vertex(660, 300, 140, 160, "sg-alb: 80 from 0.0.0.0/0",
  "fillColor=none;strokeColor=#DD3522;dashed=1;verticalAlign=bottom;fontStyle=0;fontSize=10;fontColor=#DD3522;whiteSpace=wrap;html=1;");
const alb = shapeIcon(695, 320, 70, 70, "", "application_load_balancer", NET);
text(805, 380, 190, 60, "<b>Application Load Balancer</b><br>internet-facing · Listener :80<br>default → 404", 10, NET);

edge(users, igw, "HTTP :80", "#232F3E", false, "exitX=1;exitY=0.5;entryX=0;entryY=0.5;");
edge(igw, alb, "", NET);
edge(nat, igw, "egress", NET, true, "exitX=0.5;exitY=0;entryX=0;entryY=0.75;");

// ---- per-service tasks inside private subnets ----
const serviceGroup = (x, y, color, label) =>
  box(x, y, 370, 190, label, color, { fill: "#FFFFFF", dashed: 0, align: "left", extra: "fontSize=11;arcSize=4;rounded=1;" });
const tasks = (gx, gy, names) =>
  names.forEach((n, k) => shapeIcon(gx + 40 + k * 120, gy + 55, 37, 48, n, "ecs_task", ORANGE));

const gcatA = serviceGroup(310, 615, CAT, "dev-webstore-catalog-service");
tasks(310, 615, ["catalog task 1", "catalog task 2"]);
const gcartA = serviceGroup(310, 850, CART, "dev-webstore-cart-service");
tasks(310, 850, ["cart task 1", "cart task 2", "cart task 3"]);

const gcatB = serviceGroup(780, 615, CAT, "dev-webstore-catalog-service");
tasks(780, 615, ["catalog task 3"]);
const gcartB = serviceGroup(780, 850, CART, "dev-webstore-cart-service");
tasks(780, 850, ["cart task 4", "cart task 5"]);

text(310, 1045, 850, 40,
  `<font color='${CAT}'><b>catalog</b>: DesiredCount 3</font> · <font color='${CART}'><b>cart</b>: DesiredCount 5</font> · ` +
  "MinHealthy 50% · MaxPercent 200% · circuit breaker + rollback · health check GET /actuator/health (30s)", 10);

// ALB listener rules → target groups → tasks
edge(alb, gcatA, "/catalog/* → dev-webstore-catalog-tg", CAT, false, "exitX=0.25;exitY=1;entryX=0.75;entryY=0;");
edge(alb, gcatB, "", CAT, false, "exitX=0.75;exitY=1;entryX=0.25;entryY=0;");
edge(alb, gcartA, "/cart/* → dev-webstore-cart-tg", CART, false, "exitX=0;exitY=0.75;entryX=0;entryY=0.5;");
edge(alb, gcartB, "", CART, false, "exitX=1;exitY=0.75;entryX=1;entryY=0.5;");
edge(cluster, nat, "image pull / logs", NET, true, "exitX=0.05;exitY=0;entryX=0.5;entryY=1;");

// ---- per-service CI/CD panels ----
const github = vertex(2110, 700, 60, 60, "GitHub<br>(CodeConnections)",
  "sketch=0;outlineConnect=0;fontColor=#232F3E;fillColor=#232F3E;strokeColor=none;verticalLabelPosition=bottom;verticalAlign=top;" +
  "align=center;html=1;fontSize=11;aspect=fixed;shape=mxgraph.aws4.git_repository;");

function servicePanel(y0, name, color, svcTarget) {
  const x0 = 1270;
  box(x0, y0, 740, 490, `webstore-${name}  —  per-service stacks (dev-webstore-${name}-*)`, color, { fill: "#FFFFFF", align: "left" });
  const ecr = resIcon(x0 + 70, y0 + 60, `Amazon ECR<br>dev-webstore-${name}-repo`, "ecr", ORANGE);
  const cb = resIcon(x0 + 560, y0 + 60, `CodeBuild<br>dev-webstore-${name}-codebuild`, "codebuild", PURPLE);
  const eb = resIcon(x0 + 560, y0 + 210, "EventBridge rule<br>Build SUCCEEDED", "eventbridge", PINK);
  const lam = resIcon(x0 + 320, y0 + 210, `Lambda (Python 3.12)<br>dev-webstore-${name}-deploy-trigger`, "lambda", ORANGE);
  const ssm = shapeIcon(x0 + 322, y0 + 360, 56, 58, `SSM Parameter<br>/dev-webstore-${name}-imageTag`, "parameter_store", PINK);
  resIcon(x0 + 560, y0 + 360, "CloudWatch Logs<br>CodeBuild + Lambda (14d)", "cloudwatch_2", PINK);
  shapeIcon(x0 + 60, y0 + 375, 78, 44, "IAM roles: task execution,<br>task, CodeBuild, Lambda", "role", RED);

  edge(github, cb, "source", "#232F3E", false, "exitX=0;exitY=0.5;entryX=1;entryY=0.5;");
  edge(cb, ecr, "docker build + push", color);
  edge(cb, eb, "build state change", color);
  edge(eb, lam, "invoke", color);
  edge(lam, ssm, "put imageTag", color);
  edge(lam, svcTarget, "register task def +<br>UpdateService (force)", color, false, "exitX=0;exitY=0.5;entryX=1;entryY=0.5;");
  edge(svcTarget, ecr, "pull image", ORANGE, true, "exitX=1;exitY=0.2;entryX=0;entryY=0.5;");
}
servicePanel(160, "catalog", CAT, gcatB);
servicePanel(680, "cart", CART, gcartB);

// ---- CloudFormation stacks legend ----
resIcon(245, 1205, "", "cloudformation", PINK, 48);
text(305, 1195, 1700, 200,
  "<b>CloudFormation stacks — deploy order</b><br>" +
  "1. <b>dev-webstore-vpc</b> (shared) — VPC, IGW, 2 public + 2 private subnets, NAT GW, route tables, sg-alb, sg-ecs<br>" +
  "2. <b>dev-webstore-ecs-infra</b> (shared) — ECS cluster, ALB, Listener :80 (default 404)<br>" +
  `3. per service (<font color='${CAT}'><b>catalog</b></font>, <font color='${CART}'><b>cart</b></font>):  ` +
  "a. <b>dev-webstore-&lt;svc&gt;-iam</b> (task execution + task roles) → " +
  "b. <b>-codebuild</b> (ECR, CodeBuild project/role, log group) → " +
  "c. <b>-service</b> (ECS service, target group, listener rule) → " +
  "d. <b>-pipeline</b> (EventBridge rule, Lambda + role + log group)", 12);

const xml = '<mxfile host="app.diagrams.net"><diagram id="webstore-aws" name="webstore dev - AWS">' +
  '<mxGraphModel dx="2200" dy="1500" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" ' +
  'pageScale="1" pageWidth="2250" pageHeight="1450" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  cells.join("") + "</root></mxGraphModel></diagram></mxfile>";
fs.writeFileSync(OUT, xml, "utf8");
console.log("wrote", OUT, cells.length, "cells");
