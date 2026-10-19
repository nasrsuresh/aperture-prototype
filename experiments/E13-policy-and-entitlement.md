# E13: no policy, no entitlement, no run

**Claim in submission (B Decision 5, B Decision 6):** an organization must opt in to third-party filters (`allowThirdPartyFilters`); a marketplace pipeline cannot even be saved otherwise. Running a marketplace step additionally requires an entitlement for that filter, checked at admission (batch creation, submit, or single request), and the price terms in force are pinned on the batch.

**Prediction:** with the policy off, saving a marketplace pipeline returns 403 `third_party_disabled`. With the policy on but no entitlement, `POST /images sepia-3p` returns 402 `no_entitlement`. After `POST /entitlements`, the same request returns 202. A batch admitted with an entitlement shows `admittedEntitlements` with the terms.

**Commands:** `npm run demo`, section 7; or:

```
npm run cli -- policy false
npm run cli -- create-pipeline '[{"type":"marketplace","filterId":"sepia-3p"}]'
npm run cli -- policy true
APERTURE_ORG=acme-noent npm run cli -- policy true
APERTURE_ORG=acme-noent npm run cli -- single experiments/scratch/small.jpg sepia-3p
npm run cli -- entitle sepia-3p --cents 2 --share 0.7
npm run cli -- status <E9 batch>            # admittedEntitlements
```

**Result**

```
allowThirdPartyFilters=false -> POST /pipelines (marketplace step) -> 403 {"code":"third_party_disabled","message":"third-party filters are disabled for this organization"}
org acme-noent, policy on, no entitlement -> POST /images sepia-3p -> 402 {"code":"no_entitlement","message":"organization has no entitlement for filter sepia-3p"}
POST /entitlements -> 201 {"filterId":"sepia-3p","priceTerms":{"perInvocationCents":2,"developerShare":0.7}}
GET /batches/<E9 batch>:  "admittedEntitlements": { "sepia-3p": { "perInvocationCents": 2, "developerShare": 0.7 } }
```

**Explanation:** two different questions at two different moments. The policy is an organizational decision ("may our data ever touch third-party code?"), so it is enforced at authoring time: the pipeline resolver refuses to resolve a marketplace step for an org that has not opted in, and no version is ever saved. The entitlement is commercial ("have we bought this filter?"), so it is enforced at admission, and the terms are copied onto the Batch item so a price change mid-run does not change what the batch is billed. The 402 status is deliberate: it is the HTTP code that means "payment required", and the client can show a buy button. The registry itself (`FILTER#<id> / V#<version>`) is global, not per org, which is what lets one developer's function serve many tenants while each tenant's permission to use it is separate data.

**Teach-back:** _(write in your own words after reading)_
