# Run the CloudFormation Stacks

Command reference for deploying and operating the stacks in this folder. Commands are written
for **PowerShell** (backtick `` ` `` line continuation). Run them from the `cloud-formation-stacks/` folder (`cd cloud-formation-stacks` from the repository root), where the template paths below resolve.

**Contents**

1. [Prerequisites](#1-prerequisites)
2. [GitHub connection](#2-github-connection-private-repositories)
3. [Shared variables](#3-shared-variables)
4. [Deploy the stacks](#4-deploy-the-stacks)
5. [Build and redeploy an image](#5-build-and-redeploy-an-image)
6. [Utilities: CloudFormation](#6-utilities-cloudformation)
7. [Utilities: operations](#7-utilities-operations)

---

## 1. Prerequisites

- Install the [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html).
- Authenticate with `aws login` (OAuth) or any configured profile.
- Your application (service) repository must contain a **`buildspec.yml`** and a `Dockerfile`. The CodeBuild
  stack only creates the project; the build steps come from your `buildspec.yml`. See
  [README.md](README.md#your-application-needs-a-buildspecyml) for what it must do and an example.

> **Never hardcode values directly in a command.** Account IDs, ARNs and tokens are sensitive;
> keep them in shell variables (section 3).

---

## 2. GitHub connection (private repositories)

Only needed if the application repository is private. Pick one option.

### Option A: OAuth (console, one-time)

1. AWS Console → CodeBuild → Source credentials → Connect to GitHub → OAuth.
2. Every CodeBuild project in the account and region reuses it automatically.
3. No template changes are needed.

Create the connection in the console (for example `myapplication-codebuild-connection`) and keep its
ARN: it is the `GitHubConnectionArn` parameter.

> `GitHubConnectionArn` has **no default** in the template. It **must** be passed through
> `--parameter-overrides` at deploy time.

### Option B: Personal Access Token (PAT) via SSM

Store the PAT first:

```powershell
aws ssm put-parameter `
  --name /myapplication/codebuild/github-token `
  --value "ghp_xxxxxxxxxxxx" `
  --type SecureString `
  --region us-east-1
```

---

## 3. Shared variables

Set these once per shell session (cmd or PowerShell). Every stack name and `--parameter-overrides`
value below is built from them.

```powershell
$Environment         = "dev"                                  # dev | staging | prod
$ProductName         = "<your product name>"
$StackPrefix         = "$Environment-$ProductName"            # e.g. "dev-yourproduct"
$AppServiceName      = "<your app service name>"
$AwsAccountId        = "<12-digit AWS account ID>"
$GitHubConnectionArn = "<arn:aws:codeconnections:...>"   # create it first: section 2, "GitHub connection (private repositories)"
$GitHubOwner         = "<GitHub org or user>"
$GitHubRepo          = "<GitHub repository name>"
$GitHubBranch        = "main"
$ALBListenerRulePriority = 10                             # unique per service on the shared ALB (e.g. 10, 20, 30...)
```

---

## 4. Deploy the stacks

| Step | Scope | What it creates | Stack name |
|---|---|---|---|
| 1 | Once per product | VPC, subnets, security groups | `$StackPrefix-vpc` |
| 2 | Once per product | ECS cluster, ALB, listener | `$StackPrefix-ecs-infra` |
| 3 | Per service | ECR repository, CodeBuild project | `$StackPrefix-$AppServiceName-codebuild` |
| 4 | Per service | ECS task execution role and task role | `$StackPrefix-$AppServiceName-iam` |
| 4b | Per service (optional) | Amazon Bedrock invoke permissions for the task role | `$StackPrefix-$AppServiceName-bedrock-iam-<model-label>` |
| 5 | Per service | Aurora PostgreSQL Serverless v2, DB secret | `$StackPrefix-$AppServiceName-rds` |
| 6 | Per service | SSM parameter with the image tag | (not a stack) |
| 7 | Per service | Task definition, ECS service, ALB rule | `$StackPrefix-$AppServiceName-ecs-service` |
| 8 | Per service | EventBridge rule and Lambda that redeploy on build success | `$StackPrefix-$AppServiceName-pipeline` |

### Step 1: VPC

VPC, subnets, security groups. Once per product.

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-vpc" `
  --template-file ./aws-vpc-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName
```

### Step 2: ECS infrastructure

ECS cluster, ALB and listener. Once per product.

```powershell
aws cloudformation deploy `
  --template-file ./aws-ecs-infra-stack.yml `
  --stack-name "$StackPrefix-ecs-infra" `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --region us-east-1 `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AwsAccountId=$AwsAccountId
```

### Step 3: Build (CodeBuild and ECR)

CodeBuild project and ECR repository. Once per service.

```powershell
aws cloudformation deploy `
  --template-file ./per-service/aws-codebuild-stack.yml `
  --stack-name "$StackPrefix-$AppServiceName-codebuild" `
  --capabilities CAPABILITY_NAMED_IAM `
  --region us-east-1 `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AwsAccountId=$AwsAccountId `
    AppServiceName=$AppServiceName `
    GitHubOwner=$GitHubOwner `
    GitHubRepo=$GitHubRepo `
    GitHubBranch=$GitHubBranch `
    GitHubConnectionArn=$GitHubConnectionArn
```

### Step 4: IAM

ECS task role and task execution role. Once per service.

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-$AppServiceName-iam" `
  --template-file ./per-service/aws-iam-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AppServiceName=$AppServiceName
```

### Step 4b: Bedrock IAM (optional)

Only for services that call Amazon Bedrock. Creates a managed policy with
`bedrock:InvokeModel` / `bedrock:InvokeModelWithResponseStream` and attaches it to the
task role from step 4, so deploy it **after** step 4. Enable the model in the Bedrock console
(Model access) first.

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-$AppServiceName-bedrock-iam-jamba-mini" `
  --template-file ./per-service/aws-bedrock-iam-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AppServiceName=$AppServiceName `
    BedrockModelId=anthropic.claude-sonnet-4-5-20250929-v1:0 `
    InferenceProfileId=us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

Leave `InferenceProfileId` out if the service calls the foundation model directly.

**One stack per model.** The model ID is part of the policy name and of the export name (for example
`...-bedrock-invoke-ai21-jamba-1-5-mini-v1-0-policy`), so to allow another model run the same command again
with that model's `BedrockModelId` and a different stack name, for example
`$StackPrefix-$AppServiceName-bedrock-iam-nova-pro`. Each stack attaches one more managed policy to the task role,
and an IAM role allows 10 managed policies by default.

The stack works for any Bedrock model provider. Parameter values for some common models (checked
against `us-east-1`; availability changes, so confirm with `aws bedrock list-foundation-models` and
`aws bedrock list-inference-profiles`; the `modelLifecycle` status shows `ACTIVE` or `LEGACY`):

| Model | `BedrockModelId` | `InferenceProfileId` |
|---|---|---|
| Anthropic Claude Haiku 4.5 | `anthropic.claude-haiku-4-5-20251001-v1:0` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| Anthropic Claude Sonnet 4.5 | `anthropic.claude-sonnet-4-5-20250929-v1:0` | `us.anthropic.claude-sonnet-4-5-20250929-v1:0` |
| AI21 Jamba 1.5 Mini (`LEGACY`, may be retired) | `ai21.jamba-1-5-mini-v1:0` | _(leave out)_ |
| Amazon Nova Pro | `amazon.nova-pro-v1:0` | _(leave out, or `us.amazon.nova-pro-v1:0`)_ |
| Mistral Large 3 | `mistral.mistral-large-3-675b-instruct` | _(leave out)_ |

Whatever the provider, the service must be configured with the same model (for `customers-api`, the
`AWS_BEDROCK_MODEL_ID` variable; its default is `ai21.jamba-1-5-mini-v1:0`), model access must be enabled for
it in the Bedrock console, and its quotas (requests and tokens per minute and per day) are set per model.
The use case form below applies to Anthropic models only.

### Step 5: RDS Aurora

Aurora PostgreSQL Serverless v2 cluster, DB secret, subnet group and security group. Once per service.

> Deploy this **before** the ECS service stack (step 7). That stack imports
> `DB_HOST`, `DB_PORT`, `DB_NAME` and `DB_SECRET_ARN` from it.

```powershell
aws cloudformation deploy `
  --stack-name "$StackPrefix-$AppServiceName-rds" `
  --template-file ./per-service/aws-rds-aurora-stack.yml `
  --region us-east-1 `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AppServiceName=$AppServiceName `
    DbName=$ProductName
```

### Step 6: SSM parameter (image tag)

The ECS task definition reads the image tag from SSM Parameter Store. The parameter name **starts with a
slash**. Add `--overwrite` to change an existing value.

```powershell
aws ssm put-parameter `
  --name "/$StackPrefix-$AppServiceName-imageTag" `
  --value 1.0.0 `
  --type String `
  --region us-east-1 `
  --tags Key=Environment,Value=$Environment `
         Key=ProductName,Value=$ProductName `
         Key=AppServiceName,Value=$AppServiceName `
         Key=Layer,Value=infrastructure
```

### Step 7: ECS service

Task definition, ECS service and ALB listener rule. Once per service.

> **`ImageTag` is not a parameter.** The task definition resolves the tag from SSM (step 6).
>
> **`HealthCheckPath`:** do **not** pass `/$AppServiceName/actuator/health`. The template builds the target
> group health-check path as `/${AppServiceName}${HealthCheckPath}`, so `HealthCheckPath` must stay just the
> suffix (default `/actuator/health`). The application must run with
> `server.servlet.context-path=/$AppServiceName`. Passing the combined path would double it
> (for example `/webstore/webstore/actuator/health`).
>
> **`ListenerRulePriority`** (`$ALBListenerRulePriority`) must be unique for every service on the shared ALB.

```powershell
aws cloudformation deploy `
  --template-file ./per-service/aws-ecs-service-stack.yml `
  --stack-name "$StackPrefix-$AppServiceName-ecs-service" `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --region us-east-1 `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AppServiceName=$AppServiceName `
    ListenerRulePriority=$ALBListenerRulePriority `
    AwsAccountId=$AwsAccountId
```

### Step 8: CI/CD pipeline trigger

EventBridge → Lambda → ECS redeploy. Once per service.

After this stack is deployed, every successful CodeBuild build registers a new ECS task definition revision
and force-redeploys the ECS service. No manual redeployment is needed. All resource names (CodeBuild project,
ECR URI, ECS cluster, service and task family, container name, SSM parameter) are derived from
`ProductName`, `AppServiceName` and `Environment`, so no extra parameters are required.

```powershell
aws cloudformation deploy `
  --template-file ./per-service/aws-pipeline-stack.yml `
  --stack-name "$StackPrefix-$AppServiceName-pipeline" `
  --capabilities CAPABILITY_NAMED_IAM `
  --region us-east-1 `
  --parameter-overrides `
    Environment=$Environment `
    ProductName=$ProductName `
    AwsAccountId=$AwsAccountId `
    AppServiceName=$AppServiceName
```

To confirm the pipeline works after a build, see [Verify the pipeline](#verify-the-pipeline) in section 7.


---

## 5. Build and redeploy an image

### 5.1 Build and push a new image (via CodeBuild)

```powershell
aws codebuild start-build `
  --project-name "$StackPrefix-$AppServiceName-codebuild" `
  --region us-east-1 `
  --environment-variables-override name=IMAGE_TAG,value=1.0.0,type=PLAINTEXT
  # add --source-version develop to build another branch
```

### 5.2 Set the desired count and force a new deployment

This is the fastest path and needs no CloudFormation change.

> **First deploy:** run this after the first successful build (5.1) to make ECS start the service with the new image.
>
> **Later deploys:** no forced deployment is needed. The pipeline triggers one after every successful build.

```powershell
aws ecs update-service `
  --cluster "$StackPrefix-cluster" `
  --service "$StackPrefix-$AppServiceName-service" `
  --desired-count 3 `
  --force-new-deployment `
  --region us-east-1
```

---

## 6. Utilities: CloudFormation

### Delete stacks

Delete in reverse order of deployment: `ecs-service`, `pipeline`, `rds`, `bedrock-iam-<model-label>` stacks (if deployed), `iam`, `codebuild` (per service),
then `ecs-infra` and `vpc` (per product). The optional IoT / Kafka / DynamoDB stacks have their own teardown order in
[cloud-formation-stacks/iot-async-dynamo/README.md](cloud-formation-stacks/iot-async-dynamo/README.md). Example for one service stack:

```powershell
aws cloudformation delete-stack --stack-name "$StackPrefix-$AppServiceName-ecs-service"
```

### Read the ALB DNS name

```powershell
aws cloudformation describe-stacks `
  --stack-name "$StackPrefix-ecs-infra" `
  --region us-east-1 `
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" `
  --output text
```

### Continue a failed update rollback

```powershell
aws cloudformation continue-update-rollback `
  --stack-name "$StackPrefix-$AppServiceName-ecs-service"
```

### Change a stack parameter (for example `DesiredCount`)

Updates a parameter without changing the template or redeploying the whole stack. When the ECS resources
(task definition, service, cluster) are defined in CloudFormation, this is the better approach. Registering
task definitions by hand becomes risky in that case.

```powershell
aws cloudformation update-stack `
  --stack-name "$StackPrefix-$AppServiceName-ecs-service" `
  --use-previous-template `
  --parameters `
    ParameterKey=ProductName,UsePreviousValue=true `
    ParameterKey=Environment,UsePreviousValue=true `
    ParameterKey=AppServiceName,UsePreviousValue=true `
    ParameterKey=ContainerPort,UsePreviousValue=true `
    ParameterKey=HealthCheckPath,UsePreviousValue=true `
    ParameterKey=HealthCheckIntervalSeconds,UsePreviousValue=true `
    ParameterKey=HealthCheckTimeoutSeconds,UsePreviousValue=true `
    ParameterKey=HealthyThresholdCount,UsePreviousValue=true `
    ParameterKey=UnhealthyThresholdCount,UsePreviousValue=true `
    ParameterKey=ListenerRulePriority,UsePreviousValue=true `
    ParameterKey=TaskCpu,UsePreviousValue=true `
    ParameterKey=TaskMemory,UsePreviousValue=true `
    ParameterKey=LogRetentionDays,UsePreviousValue=true `
    ParameterKey=DesiredCount,ParameterValue=3 `
  --capabilities CAPABILITY_NAMED_IAM CAPABILITY_AUTO_EXPAND `
  --region us-east-1
```

---

## 7. Utilities: operations

### Check a build

Get the build ID from the `start-build` output, then:

```powershell
aws codebuild batch-get-builds `
  --ids <build-id> `
  --region us-east-1 `
  --query "builds[0].{status:buildStatus,phase:currentPhase}"
```

### Verify the pipeline

Check the Lambda logs after a build to confirm the auto-deploy fired:

```powershell
aws logs tail "/aws/lambda/$StackPrefix-$AppServiceName-deploy-trigger" --follow --region us-east-1
```

Check the current deployed image tag:

```powershell
aws ssm get-parameter `
  --name "/$StackPrefix-$AppServiceName-imageTag" `
  --region us-east-1 `
  --query "Parameter.Value" `
  --output text
```

### Restore a specific task definition revision

Omit `--task-definition` to use the latest revision.

```powershell
aws ecs update-service `
  --cluster "$StackPrefix-cluster" `
  --service "$StackPrefix-$AppServiceName-service" `
  --force-new-deployment `
  --region us-east-1 `
  --task-definition "$StackPrefix-$AppServiceName-task:5"
```

### List images in ECR

```powershell
aws ecr describe-images `
  --repository-name "$StackPrefix-$AppServiceName-repo" `
  --region us-east-1 `
  --query 'sort_by(imageDetails,& imagePushedAt)[*].[imageTags[0],imagePushedAt]' `
  --output table
```

### Inspect task definitions

```powershell
aws ecs list-task-definition-families --region us-east-1

aws ecs list-task-definitions `
  --family-prefix "$StackPrefix-$AppServiceName-task" `
  --region us-east-1 `
  --sort DESC

aws ecs describe-task-definition `
  --task-definition "$StackPrefix-$AppServiceName-task:5" `
  --query 'taskDefinition.containerDefinitions[*].image'
```

### Look up the database connection details and credentials

Use these commands to get the real values of a deployed stack. The second one returns the **secret
database credentials** from Secrets Manager, so treat the output as sensitive: don't paste it into
tickets or commit it. The commands use the shared variables from [section 3](#3-shared-variables).

```powershell
# Look up the real values for the deployed stack (endpoint, port, database name, secret ARN):
aws cloudformation describe-stacks --stack-name "$StackPrefix-$AppServiceName-rds" --query "Stacks[0].Outputs" --region us-east-1

# Get the secret database credentials:
aws secretsmanager get-secret-value --secret-id "$StackPrefix-$AppServiceName-db-secret" --query SecretString --output text --region us-east-1
```

### Bedrock: Anthropic use case form and model check

Anthropic models on Bedrock need the **use case details form** submitted once per account. Until it is, the
service fails with `Model use case details have not been submitted for this account` (HTTP 404). After
submitting, allow up to 15 minutes. Run these in order.

Check whether the form is already on file (a `ResourceNotFoundException` means it has not been submitted):

```powershell
aws bedrock get-use-case-for-model-access --region us-east-1
```

Submit the form. `--form-data` is base64-encoded JSON. The field names below are not verified, so compare
them with the console form (Bedrock → Model catalog → an Anthropic model) first, or submit it in the console instead:

```powershell
$FormJson = '{"companyName":"<name>","companyWebsite":"<url>","intendedUsers":"0","industryOption":"Technology","otherIndustryOption":"","useCases":"<describe the use case>"}'
$FormData = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($FormJson))

aws bedrock put-use-case-for-model-access `
  --form-data $FormData `
  --region us-east-1
```

Test the model directly, without going through the service. It returns the same error until the form takes
effect, then a reply:

```powershell
$Messages = '[{\"role\":\"user\",\"content\":[{\"text\":\"hi\"}]}]'

aws bedrock-runtime converse `
  --model-id us.anthropic.claude-sonnet-4-5-20250929-v1:0 `
  --messages $Messages `
  --region us-east-1
```

If the test fails with an access error instead, confirm the inference profile is available in the region:

```powershell
aws bedrock list-inference-profiles `
  --region us-east-1 `
  --query "inferenceProfileSummaries[?contains(inferenceProfileId,'claude-sonnet-4-5')].inferenceProfileId"
```
