import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export function loadMonitorConfigFromMonitorsXML(connectorName) {
    const path = GLib.get_home_dir() + '/.config/monitors.xml';
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null)) {
        // console.log('monitors.xml does not exist.');
        return null;
    }

    try {
        const [ok, contentsBytes] = GLib.file_get_contents(path);
        if (!ok || !contentsBytes) {
            // console.warn('Failed to read monitors.xml contents.');
            return null;
        }
        const contents = new TextDecoder().decode(contentsBytes); 

        const configurationsRegex = /<configuration>([\s\S]*?)<\/configuration>/gm;
        let configurationMatch;
        let iteration = 0;

        while ((configurationMatch = configurationsRegex.exec(contents)) !== null) {
            iteration++;
            const currentConfigurationContent = configurationMatch[1];
            // console.log(`Parsing monitors.xml: Looking in <configuration> block #${iteration}`);

            const logicalMonitorRegex = /<logicalmonitor>([\s\S]*?)<\/logicalmonitor>/gm;
            let logicalMonitorMatch;
            while ((logicalMonitorMatch = logicalMonitorRegex.exec(currentConfigurationContent)) !== null) {
                const logicalMonitorContent = logicalMonitorMatch[1];
    
                const connectorRegex = new RegExp(`<connector>${connectorName}</connector>`);
                if (connectorRegex.test(logicalMonitorContent)) {
                    const xMatch = /<x>([-\d]+)<\/x>/.exec(logicalMonitorContent);
                    const yMatch = /<y>([-\d]+)<\/y>/.exec(logicalMonitorContent);
                    const scaleMatch = /<scale>([0-9\.]+)<\/scale>/.exec(logicalMonitorContent);
                    const rotationMatch = /<rotation>(normal|left|right|upside-down)<\/rotation>/.exec(logicalMonitorContent);
                    
                    let transformValue = 0; 
                    if (rotationMatch) {
                        switch (rotationMatch[1]) {
                            case 'normal': transformValue = 0; break;
                            case 'left': transformValue = 1; break;
                            case 'upside-down': transformValue = 2; break;
                            case 'right': transformValue = 3; break;
                        }
                    }
                    
                    if (xMatch && yMatch && scaleMatch) {
                        const primaryMatch = /<primary>yes<\/primary>/.test(logicalMonitorContent);
                        const config = {
                            x: parseInt(xMatch[1], 10),
                            y: parseInt(yMatch[1], 10),
                            scale: parseFloat(scaleMatch[1]),
                            transform: transformValue,
                            isPrimary: primaryMatch,
                        };
                        // console.log(`Loaded config from monitors.xml (configuration #${iteration}) for ${connectorName}:`, config);
                        return config; 
                    }
                }
            }
        }
        // console.log(`Connector ${connectorName} not found in any <configuration> block of monitors.xml.`);
        return null;
    } catch (e) {
        console.error(`Error processing monitors.xml for ${connectorName}: ${e}`);
        return null;
    }
}

/**
 * Load the full monitor configuration from monitors.xml for ALL monitors
 * in the same <configuration> block that contains the target connector.
 * Returns an object mapping connector names to {x, y, scale, transform}, or null.
 */
export function loadFullConfigFromMonitorsXML(targetConnector) {
    const path = GLib.get_home_dir() + '/.config/monitors.xml';
    const file = Gio.File.new_for_path(path);

    if (!file.query_exists(null)) return null;

    try {
        const [ok, contentsBytes] = GLib.file_get_contents(path);
        if (!ok || !contentsBytes) return null;
        const contents = new TextDecoder().decode(contentsBytes);

        const configurationsRegex = /<configuration>([\s\S]*?)<\/configuration>/gm;
        let configurationMatch;

        while ((configurationMatch = configurationsRegex.exec(contents)) !== null) {
            const currentConfigurationContent = configurationMatch[1];

            const connectorCheck = new RegExp(`<connector>${targetConnector}</connector>`);
            if (!connectorCheck.test(currentConfigurationContent)) continue;

            const result = {};
            const logicalMonitorRegex = /<logicalmonitor>([\s\S]*?)<\/logicalmonitor>/gm;
            let logicalMonitorMatch;

            while ((logicalMonitorMatch = logicalMonitorRegex.exec(currentConfigurationContent)) !== null) {
                const lmContent = logicalMonitorMatch[1];
                const connectorMatch = /<connector>([^<]+)<\/connector>/.exec(lmContent);
                if (!connectorMatch) continue;

                const connector = connectorMatch[1];
                const xMatch = /<x>([-\d]+)<\/x>/.exec(lmContent);
                const yMatch = /<y>([-\d]+)<\/y>/.exec(lmContent);
                const scaleMatch = /<scale>([0-9\.]+)<\/scale>/.exec(lmContent);
                const rotationMatch = /<rotation>(normal|left|right|upside-down)<\/rotation>/.exec(lmContent);

                let transformValue = 0;
                if (rotationMatch) {
                    switch (rotationMatch[1]) {
                        case 'normal': transformValue = 0; break;
                        case 'left': transformValue = 1; break;
                        case 'upside-down': transformValue = 2; break;
                        case 'right': transformValue = 3; break;
                    }
                }

                if (xMatch && yMatch && scaleMatch) {
                    const primaryMatch = /<primary>yes<\/primary>/.test(lmContent);
                    result[connector] = {
                        x: parseInt(xMatch[1], 10),
                        y: parseInt(yMatch[1], 10),
                        scale: parseFloat(scaleMatch[1]),
                        transform: transformValue,
                        isPrimary: primaryMatch,
                    };
                }
            }

            if (Object.keys(result).length > 0) return result;
        }
        return null;
    } catch (e) {
        console.error(`Error processing monitors.xml for full config: ${e}`);
        return null;
    }
}
 