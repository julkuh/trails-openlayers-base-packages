// SPDX-FileCopyrightText: con terra GmbH and contributors
// SPDX-License-Identifier: Apache-2.0
import { useService } from "open-pioneer:react-hooks";
import { useEffect, useRef } from "react";
import { useAsync } from "react-use";

export interface OlComponentConfig {
    mapId: string;
}

export interface MapComponentProperties extends OlComponentConfig {
    viewPadding?: Array<number> | undefined;
}

export function MapContainer(props: MapComponentProperties) {
    const mapElement = useRef<HTMLDivElement>(null);

    const olMapRegistry = useService("open-layers-map-service");
    const mapPromise = olMapRegistry.getMap(props.mapId);
    const mapState = useAsync(async () => await mapPromise);

    useEffect(() => {
        if (mapState.value) {
            if (mapElement.current) {
                olMapRegistry.setContainer(props.mapId, mapElement.current);
            }
            return () => olMapRegistry.setContainer(props.mapId, undefined);
        }
    }, [mapState.value, olMapRegistry, props.mapId]);

    useEffect(() => {
        const mapView = mapState.value?.getView();
        if (props.viewPadding && mapView) {
            const center = mapView.getCenter();
            mapView.padding = props.viewPadding;
            mapView.animate({ center, duration: 300 });
        }
    }, [props.viewPadding, mapState]);

    const mapContainer: React.CSSProperties = {
        height: "100%"
    };

    return <div ref={mapElement} style={mapContainer}></div>;
}