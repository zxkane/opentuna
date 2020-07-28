import cdk = require('@aws-cdk/core');
import ec2 = require('@aws-cdk/aws-ec2');
import ecs = require('@aws-cdk/aws-ecs');
import logs = require('@aws-cdk/aws-logs');
import elbv2 = require('@aws-cdk/aws-elasticloadbalancingv2');
import ecr_assets = require('@aws-cdk/aws-ecr-assets');
import autoscaling = require('@aws-cdk/aws-autoscaling');
import path = require('path');

export interface WebPortalProps extends cdk.NestedStackProps {
    readonly vpc: ec2.IVpc;
    readonly externalALBListener: elbv2.ApplicationListener;
    readonly ecsCluster: ecs.Cluster;
    readonly tunaManagerASG: autoscaling.AutoScalingGroup;
    readonly tunaManagerALBTargetGroup: elbv2.ApplicationTargetGroup;
}

export class WebPortalStack extends cdk.NestedStack {
    constructor(scope: cdk.Construct, id: string, props: WebPortalProps) {
        super(scope, id, props);

        const stack = cdk.Stack.of(this);
        const usage = 'WebPortal';

        const imageAsset = new ecr_assets.DockerImageAsset(this, `${usage}DockerImage`, {
            directory: path.join(__dirname, '../web-portal'),
            repositoryName: "opentuna/web-portal"
        });

        const httpPort = 80;
        const taskDefinition = new ecs.FargateTaskDefinition(this, `${usage}TaskDefiniton`, {});
        const logGroup = new logs.LogGroup(this, `${usage}LogGroup`, {
            logGroupName: `/opentuna/webportal`,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        const container = taskDefinition.addContainer("web", {
            image: ecs.ContainerImage.fromDockerImageAsset(imageAsset),
            logging: new ecs.AwsLogDriver({
                streamPrefix: usage,
                // like [16/Jul/2020:02:24:46 +0000]
                datetimeFormat: "\\[%d/%b/%Y:%H:%M:%S %z\\]",
                logGroup,
            }),
        });
        container.addPortMappings({
            containerPort: httpPort,
        });

        const service = new ecs.FargateService(this, `${usage}Fargate`, {
            cluster: props.ecsCluster,
            taskDefinition,
            platformVersion: ecs.FargatePlatformVersion.VERSION1_4,
        });

        // one target can have at most 5 path patterns, so split them
        // route web files to this service
        let webTargetGroup = new elbv2.ApplicationTargetGroup(scope, `${usage}WebTargetGroup`, {
            port: httpPort,
            vpc: props.vpc,
            slowStart: cdk.Duration.seconds(60),
            deregistrationDelay: cdk.Duration.seconds(10),
            targets: [service],
        });
        props.externalALBListener.addTargetGroups(`${usage}TargetGroup`, {
            priority: 10,
            targetGroups: [webTargetGroup],
            conditions: [elbv2.ListenerCondition.pathPatterns([
                "/",
                "/404.html",
                "/index.html",
                "/robots.txt",
                "/sitemap.xml",
            ])],
        })
        props.externalALBListener.addTargetGroups(`${usage}TargetGroup2`, {
            targetGroups: [webTargetGroup],
            priority: 15,
            conditions: [elbv2.ListenerCondition.pathPatterns([
                "/help/*",
                "/news/*",
                "/static/*",
                "/status/*",
            ])],
        })

        // redirect /static/tunasync.json to /jobs
        props.externalALBListener.addAction(`${usage}RedirectHTTPAction`, {
            action: elbv2.ListenerAction.redirect({
                path: "/jobs",
            }),
            priority: 5,
            conditions: [elbv2.ListenerCondition.pathPatterns([
                "/static/tunasync.json",
            ])],
        })
        // special handling for https
        props.externalALBListener.addAction(`${usage}RedirectHTTPSAction`, {
            action: elbv2.ListenerAction.redirect({
                protocol: "HTTPS",
                path: "/jobs",
                port: "443",
            }),
            priority: 4,
            conditions: [elbv2.ListenerCondition.pathPatterns([
                "/static/tunasync.json",
            ]), elbv2.ListenerCondition.httpHeader("CloudFront-Forwarded-Proto", [
                "HTTPS"
            ])],
        })

        // route /jobs to tuna manager
        // there is no easy way to do this yet
        // see https://github.com/aws/aws-cdk/issues/5667
        let targetGroup = new elbv2.ApplicationTargetGroup(this, `${usage}ManagerTargetGroup`, {
            port: httpPort,
            targetType: elbv2.TargetType.INSTANCE,
            vpc: props.vpc,
            healthCheck: {
                path: '/ping',
            }
        });
        const cfnAsg = props.tunaManagerASG.node.defaultChild as autoscaling.CfnAutoScalingGroup;
        cfnAsg.targetGroupArns = [props.tunaManagerALBTargetGroup.targetGroupArn, targetGroup.targetGroupArn];
        props.externalALBListener.addAction(`${usage}ManagerTarget`, {
            action: elbv2.ListenerAction.forward([targetGroup]),
            priority: 20,
            conditions: [elbv2.ListenerCondition.pathPatterns([
                "/jobs",
            ])],
        })

        cdk.Tag.add(this, 'component', usage);
    }
}
