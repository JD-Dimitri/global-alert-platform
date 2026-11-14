# GLOBAL ALERT — The world, live & mapped

Plateforme web mondiale de visualisation d'alertes et d'événements géolocalisés sur un globe 3D.
**100 % gratuite** : hébergement GitHub Pages, collecte GitHub Actions, uniquement des **sources publiques, officielles ou institutionnelles**.

## Principes

- **Aucune donnée inventée.** Une catégorie sans source fiable reste désactivée (« À connecter »).
- **« LIVE » veut dire LIVE** : affiché seulement si la dernière collecte a réussi il y a moins de 30 min.
- **Traçabilité** : chaque événement liste ses sources, son statut de vérification, sa précision de localisation et l'explication de sa gravité.
- **Multi-sources** : un même événement signalé par plusieurs sources (ex. USGS + GDACS) est fusionné, pas compté deux fois.
- **Événements ≠ objets permanents** : les infrastructures (référentiels) sont distinguées des incidents.

## Architecture

```
Sources publiques ──► GitHub Actions (toutes les 10 min)
                       collector/events.mjs     → data/events.json, data/status.json
                       collector/reference.mjs  → data/ref/*.json  (hebdomadaire)
                       collector/build-site.mjs → index.html
                     ──► GitHub Pages (site statique) ──► navigateur (globe 3D, globe.gl)
                     ──► branche `data` (dernière collecte, un seul commit)
```

Normalisation → déduplication/fusion → géolocalisation pays (point dans polygone, Natural Earth 1:50m) → gravité normalisée (1–5, ou « Indéterminée ») → statut de vérification.

## Sources et licences

### Événements (toutes les 10 min)

| Connecteur | Catégories | Licence |
|---|---|---|
| [USGS Earthquake Hazards](https://earthquake.usgs.gov/earthquakes/feed/) | Séismes | Domaine public |
| [NASA EONET v3](https://eonet.gsfc.nasa.gov/) | Feux, tempêtes, inondations, volcans, sécheresses, glace | Domaine public |
| [GDACS (CE-JRC / ONU)](https://www.gdacs.org/) | Séismes, cyclones, inondations, volcans, sécheresses, feux | Réutilisation libre avec attribution |
| [NGA ASAM](https://msi.nga.mil/Piracy) | Piraterie / brigandage maritime | Domaine public |
| [Launch Library 2](https://thespacedevs.com/llapi) | Lancements (annoncés / confirmés) | Gratuit, attribution, 15 req/h |
| [NASA JPL CNEOS](https://cneos.jpl.nasa.gov/fireballs/) | Bolides | Domaine public |
| [OMS — Disease Outbreak News](https://www.who.int/emergencies/disease-outbreak-news) | Alertes sanitaires (niveau pays) | OMS, non commercial avec attribution |
| [CISA KEV](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) | Vulnérabilités exploitées (non géolocalisées) | Domaine public |
| [IFRC Alert Hub](https://alerthub.ifrc.org/) | **Alertes officielles CAP** des autorités (≈130 pays : météo, crues, incendies, santé, sécurité…) | Alertes publiques officielles |
| [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/) | Foyers d'incendie détectés par satellite (24 h, cellules de 0,2°) | Domaine public |
| [EMSC](https://www.seismicportal.eu/) | Séismes, y compris petites magnitudes (fusionnés avec l'USGS) | Libre avec attribution |
| [GDELT 2.0 GKG](https://www.gdeltproject.org/) | **Presse — non vérifié** : accidents de la route, incendies/explosions, fusillades, agressions, enlèvements, manifestations | Libre avec attribution |

> **Couches « presse »** : catégorie déduite du titre (mots-clés FR/EN/ES/PT/DE/IT), lieu géocodé automatiquement par GDELT,
> événement retenu **uniquement si au moins 2 médias distincts** en parlent (fenêtre 36 h, même ville). Affichées « NON VÉRIFIÉ », désactivées par défaut.

### Référentiels (hebdomadaire)

| Couche | Source | Licence |
|---|---|---|
| Aéroports | [OurAirports](https://ourairports.com/data/) | Domaine public |
| Sites nucléaires, grands barrages hydro | [WRI Global Power Plant Database](https://datasets.wri.org/dataset/globalpowerplantdatabase) (figée 2021) | CC BY 4.0 |
| Centres de données | [PeeringDB](https://www.peeringdb.com/) | AUP PeeringDB |
| Spatioports | Launch Library 2 | Gratuit, attribution |
| Ports | [NGA World Port Index](https://msi.nga.mil/Publications/WPI) | Domaine public |
| Câbles sous-marins | [TeleGeography](https://www.submarinecablemap.com/) | **CC BY-NC-SA 3.0 — non commercial** |
| Bases & aérodromes militaires, postes frontières, observatoires | [OpenStreetMap](https://www.openstreetmap.org/copyright) via Overpass | ODbL — © contributeurs OSM |
| Points d'étranglement | EIA — World Oil Transit Chokepoints (liste curée) | Sources citées |
| Bourses | World Federation of Exchanges (liste curée, niveau ville) | Sources citées |

> ⚠️ Usage commercial : retirer la couche câbles (NC) et vérifier les conditions OMS et PeeringDB.

### Catégories en attente (pas encore de source gratuite et fiable branchée)

Conflits (UCDP — jeton gratuit à demander ; ACLED — compte), vols, disparitions/AMBER, pipelines (Global Energy Monitor), requins, crocodiles, zones à risque de piraterie.

## Mise en service

1. **Settings → Pages → Source : GitHub Actions.**
2. **Actions → « Collecte & déploiement » → Run workflow** (cocher « Forcer la mise à jour des référentiels » la première fois).
3. Le site est publié sur `https://<compte>.github.io/global-alert-platform/`.

Les tâches planifiées GitHub peuvent être retardées aux heures chargées, et sont suspendues après 60 jours sans activité sur le dépôt.

## Développement local

```bash
npm ci
node collector/reference.mjs        # référentiels
node collector/events.mjs           # événements
node collector/build-site.mjs       # index.html
npx serve .                         # ou python3 -m http.server
```

## Ajouter un connecteur

Dans `collector/events.mjs` : déclarer la source dans `C` (nom, URL, licence), écrire une fonction qui retourne des événements normalisés
(`id, cat, titleOrig, lat, lng, time, updated, sev, sevWhy, verif, precision, sources[]`), l'ajouter à `Promise.all`, puis déclarer la catégorie dans `src/body.html` (`FAMS`).

## Licence

Code : MIT. Données : licences de chaque source (ci-dessus). Les fonctionnalités s'inspirent d'outils existants (dont World Monitor, AGPL-3.0) ; le code est une réimplémentation indépendante.
