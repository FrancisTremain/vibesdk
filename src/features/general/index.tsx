import type { ViewDefinition } from '@/api-types';
import type { FeatureModule, FeatureContext } from '../core/types';
import { AppPreview } from '../app/components/AppPreview';

const GENERAL_VIEWS: ViewDefinition[] = [
	{
		id: 'editor',
		label: 'Code',
		iconName: 'Code2',
		tooltip: 'View and edit code',
	},
	{
		id: 'preview',
		label: 'Preview',
		iconName: 'Eye',
		tooltip: 'Live preview of your app',
	},
	{
		id: 'docs',
		label: 'Docs',
		iconName: 'FileText',
		tooltip: 'View documentation',
	},
];

const generalFeatureModule: FeatureModule = {
	id: 'general',

	getViews(): ViewDefinition[] {
		return GENERAL_VIEWS;
	},

	// The "general"/agentic behavior is the only enabled feature on the AWS
	// backend (aws/user-api-lambda/src/handler.ts's POST /api/agent comment
	// -- the phased "app" feature's blueprint-streaming UX has no AWS
	// equivalent). It still produces a standard Vite dev-server preview via
	// the harness, so it gets the same live-iframe component as "app"
	// rather than the static "no preview" placeholder this used to render
	// unconditionally, which hid every AWS-generated app's preview even
	// once previewUrl was populated (caught live).
	PreviewComponent: AppPreview,

	onActivate(context: FeatureContext) {
		console.log('[GeneralFeature] Activated for project:', context.projectType);
	},

	onDeactivate(context: FeatureContext) {
		console.log('[GeneralFeature] Deactivated from project:', context.projectType);
	},
};

export default generalFeatureModule;
