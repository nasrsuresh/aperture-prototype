#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AperturePrototypeStack } from '../lib/aperture-prototype-stack';

// Guardrail 1: the stack is pinned to the personal account and region.
// If the active credentials resolve to any other account, `cdk deploy` refuses
// with "Need to perform AWS calls for account 163395467013, but the current
// credentials are for <other>". This can never deploy into a work account.
export const PERSONAL_ACCOUNT = '163395467013';
export const REGION = 'us-east-1';

const app = new cdk.App();
new AperturePrototypeStack(app, 'AperturePrototypeStack', {
  env: { account: PERSONAL_ACCOUNT, region: REGION },
  description: 'Aperture architecture prototype (Scenario A bulk pipeline + Scenario B marketplace slice)',
});
